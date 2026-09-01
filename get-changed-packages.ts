import nodePath from "path";
import { assembleReleasePlan } from "@changesets/assemble-release-plan";
import { validateConfig } from "@changesets/config";
import { parseChangesetFile } from "@changesets/parse";
import type {
  NewChangeset,
  Package,
  Packages,
  PreState,
  WrittenConfig,
  PackageJSON as ChangesetPackageJSON,
} from "@changesets/types";
import jsYaml from "js-yaml";
import picomatch from "picomatch";
import type { ProbotOctokit } from "probot";
import subset from "semver/ranges/subset.js";
import { isChangeset } from "./is-changeset.ts";

interface PackageJSON extends ChangesetPackageJSON {
  workspaces?: ReadonlyArray<string> | { packages: ReadonlyArray<string> };
  bolt?: { workspaces: ReadonlyArray<string> };
}

interface PnpmWorkspace {
  packages: ReadonlyArray<string>;
}

type ToolType = Packages["tool"]["type"];

/** Expected validation failures that should be surfaced in the PR comment. */
export class UserValidationError extends Error {}

const changesetsV2Range = ">=2.0.0 <3.0.0";

function isChangesetsV2Range(declaredVersion: string | undefined) {
  if (declaredVersion === undefined) {
    return false;
  }

  try {
    return subset(declaredVersion, changesetsV2Range);
  } catch {
    return false;
  }
}

function getReleasePlanConfig(
  rawConfig: WrittenConfig & { prettier?: unknown },
  rootPackageJsonContent: PackageJSON,
): WrittenConfig {
  // The bot only calculates a release plan, so options used exclusively for formatting,
  // writing files, Git comparisons, publishing, and snapshots are intentionally ignored.
  const {
    access: _access,
    baseBranch: _baseBranch,
    changelog: _changelog,
    commit: _commit,
    format: _format,
    prettier: _prettier,
    snapshot: _snapshot,
    ...releasePlanConfig
  } = rawConfig;

  const declaredChangesetsVersion =
    rootPackageJsonContent.devDependencies?.["@changesets/cli"] ??
    rootPackageJsonContent.dependencies?.["@changesets/cli"];
  if (!isChangesetsV2Range(declaredChangesetsVersion)) {
    return releasePlanConfig;
  }

  const privatePackages = rawConfig.privatePackages;
  if (!("privatePackages" in rawConfig)) {
    return { ...releasePlanConfig, privatePackages: { version: true } };
  }
  if (privatePackages === true) {
    throw new UserValidationError(
      "The `privatePackages` option can only be `false` or an object when using Changesets v2.",
    );
  }
  // Changesets v2 defaulted an omitted `version` to `true` even inside the object form.
  // Only adapt that valid shape; invalid values must pass through to `validateConfig`.
  if (
    typeof privatePackages === "object" &&
    privatePackages !== null &&
    !Array.isArray(privatePackages) &&
    !("version" in privatePackages)
  ) {
    return {
      ...releasePlanConfig,
      privatePackages: { version: true, ...privatePackages },
    };
  }
  return releasePlanConfig;
}

const REPO_ROOT = "/repo";

// TODO: it might be possible to remove this if improvements to `Array.isArray` ever land
// related thread: github.com/microsoft/TypeScript/issues/36554
function isArray<T>(
  arg: T | {},
): arg is T extends ReadonlyArray<any>
  ? unknown extends T
    ? never
    : ReadonlyArray<any>
  : Array<any> {
  return Array.isArray(arg);
}

function normalizeRepoPath(path: string): string {
  if (path === "." || path === "" || path === "/") {
    return REPO_ROOT;
  }

  if (path === REPO_ROOT || path.startsWith(`${REPO_ROOT}/`)) {
    return path;
  }

  return path.startsWith("/") ? `${REPO_ROOT}${path}` : `${REPO_ROOT}/${path}`;
}

function isSubdir(pkgDir: string, file: string): boolean {
  return file === pkgDir || file.startsWith(`${pkgDir}/`);
}

function matchGlobs(
  paths: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
  { cwd }: { cwd: string },
): Array<string> {
  return paths.filter((path) => {
    const relativePath = nodePath.posix.relative(cwd, path) || ".";
    return globMatchSome([relativePath], globs);
  });
}

// Mirrors https://github.com/changesets/changesets/blob/5eeb0125f2766b9458aa1725900430b27b24116e/packages/git/src/index.ts#L346-L374
function globMatchSome(paths: ReadonlyArray<string>, patterns?: ReadonlyArray<string>): boolean {
  if (!patterns) return paths.length > 0;

  const matchers = patterns.map((pattern) => picomatch(pattern, undefined, true));
  return paths.some((path) => {
    if (path.includes("\\")) {
      path = path.replaceAll("\\", "/");
    }

    let passed = false;
    for (const matcher of matchers) {
      if (!passed) {
        if (!matcher.state.negated && matcher(path)) {
          passed = true;
        }
      } else if (matcher.state.negated && !matcher(path)) {
        passed = false;
      }
    }
    return passed;
  });
}

export const getChangedPackages = async ({
  owner,
  repo,
  ref,
  changedFiles: changedFilesPromise,
  octokit,
  installationToken,
}: {
  owner: string;
  repo: string;
  ref: string;
  changedFiles: ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  octokit: InstanceType<typeof ProbotOctokit>;
  installationToken: string;
}) => {
  let hasErrored = false;
  const encodedCredentials = Buffer.from(`x-access-token:${installationToken}`).toString("base64");

  function fetchFile(path: string) {
    const repoRelativePath = path.replace(new RegExp(`^${REPO_ROOT}/?`), "");

    return fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${repoRelativePath}`, {
      headers: {
        Authorization: `Basic ${encodedCredentials}`,
      },
    });
  }

  async function fetchJsonFile<T>(path: string): Promise<T> {
    try {
      const x = await fetchFile(path);
      return x.json() as Promise<T>;
    } catch (error) {
      hasErrored = true;
      console.error(error);
      return {} as Promise<T>;
    }
  }

  async function fetchTextFile(path: string): Promise<string> {
    try {
      const x = await fetchFile(path);
      return x.text();
    } catch (err) {
      hasErrored = true;
      console.error(err);
      return "";
    }
  }

  async function getPackage(pkgPath: string): Promise<{ dir: string; packageJson: PackageJSON }> {
    const jsonContent = await fetchJsonFile(nodePath.posix.join(pkgPath, "package.json"));
    return {
      dir: pkgPath,
      packageJson: jsonContent as PackageJSON,
    };
  }

  const rootPackageJsonContentsPromise: Promise<PackageJSON> = fetchJsonFile(
    nodePath.posix.join(REPO_ROOT, "package.json"),
  );
  const rawConfigPromise: Promise<WrittenConfig> = fetchJsonFile(
    nodePath.posix.join(REPO_ROOT, ".changeset/config.json"),
  );

  const tree = await octokit.git.getTree({
    owner,
    repo,
    recursive: "1",
    tree_sha: ref,
  });

  let preStatePromise: Promise<PreState> | undefined;
  const changesetPromises: Array<Promise<NewChangeset>> = [];
  const potentialWorkspaceDirectories: Array<string> = [];
  let isPnpm = false;
  const changedFiles = (await changedFilesPromise).map(normalizeRepoPath);

  for (const item of tree.data.tree) {
    if (!item.path) {
      continue;
    }
    const itemPath = normalizeRepoPath(item.path);
    if (nodePath.posix.basename(itemPath) === "package.json") {
      const dirPath = normalizeRepoPath(nodePath.posix.dirname(itemPath));
      potentialWorkspaceDirectories.push(dirPath);
    } else if (itemPath === `${REPO_ROOT}/pnpm-workspace.yaml`) {
      isPnpm = true;
    } else if (itemPath === `${REPO_ROOT}/.changeset/pre.json`) {
      preStatePromise = fetchJsonFile(nodePath.posix.join(REPO_ROOT, ".changeset/pre.json"));
    } else if (changedFiles.includes(itemPath) && isChangeset(item.path)) {
      const res = /\.changeset\/([^.]+)\.md/.exec(item.path);
      if (!res) {
        throw new Error("could not get name from changeset filename");
      }
      const id = res[1];

      changesetPromises.push(
        fetchTextFile(itemPath).then((text) => {
          try {
            return {
              ...parseChangesetFile(text),
              id,
            };
          } catch (error) {
            throw new UserValidationError(Error.isError(error) ? error.message : String(error), {
              cause: error,
            });
          }
        }),
      );
    }
  }
  let tool:
    | {
        type: ToolType;
        globs: ReadonlyArray<string>;
      }
    | undefined;

  if (isPnpm) {
    const pnpmWorkspaceContent = await fetchTextFile(
      nodePath.posix.join(REPO_ROOT, "pnpm-workspace.yaml"),
    );
    const pnpmWorkspace = jsYaml.safeLoad(pnpmWorkspaceContent) as PnpmWorkspace;

    if (pnpmWorkspace.packages) {
      tool = {
        type: "pnpm",
        globs: pnpmWorkspace.packages,
      };
    }
  } else {
    const rootPackageJsonContent = await rootPackageJsonContentsPromise;

    if (rootPackageJsonContent.workspaces) {
      if (isArray(rootPackageJsonContent.workspaces)) {
        tool = {
          type: "yarn",
          globs: rootPackageJsonContent.workspaces,
        };
      } else {
        tool = {
          type: "yarn",
          globs: rootPackageJsonContent.workspaces.packages,
        };
      }
    } else if (rootPackageJsonContent.bolt && rootPackageJsonContent.bolt.workspaces) {
      tool = {
        type: "bolt",
        globs: rootPackageJsonContent.bolt.workspaces,
      };
    }
  }

  const rootPackageJsonContent = await rootPackageJsonContentsPromise;

  const rootPackage: Package = {
    dir: REPO_ROOT,
    packageJson: rootPackageJsonContent,
  };

  const packages: Packages = {
    rootDir: REPO_ROOT,
    rootPackage,
    tool: { type: tool ? tool.type : "root" },
    packages: [],
  };

  if (tool) {
    if (
      !Array.isArray(tool.globs) ||
      !tool.globs.every((glob: unknown) => typeof glob === "string")
    ) {
      throw new Error("globs are not valid: " + JSON.stringify(tool.globs));
    }
    const matches = matchGlobs(potentialWorkspaceDirectories, tool.globs, { cwd: REPO_ROOT });

    packages.packages = await Promise.all(matches.map((dir) => getPackage(dir)));
  } else {
    packages.packages.push(rootPackage);
  }
  if (hasErrored) {
    throw new Error("an error occurred when fetching files");
  }

  const rawConfig = await rawConfigPromise;

  const configResult = validateConfig(
    getReleasePlanConfig(rawConfig, rootPackageJsonContent),
    packages,
  );

  if (configResult.errors) {
    throw new UserValidationError(
      "Some errors occurred when validating the changesets config:\n" +
        configResult.errors.join("\n"),
    );
  }

  // Mirrors https://github.com/changesets/changesets/blob/5eeb0125f2766b9458aa1725900430b27b24116e/packages/git/src/index.ts#L273-L304
  const changedPackages = packages.packages
    .toSorted((pkgA, pkgB) => pkgB.dir.length - pkgA.dir.length)
    .filter((pkg) => {
      const changedPackageFiles: Array<string> = [];

      for (let i = changedFiles.length - 1; i >= 0; i--) {
        const file = changedFiles[i];

        if (isSubdir(pkg.dir, file)) {
          changedFiles.splice(i, 1);
          const relativeFile = file.slice(pkg.dir.length + 1);
          changedPackageFiles.push(relativeFile);
        }
      }

      return (
        changedPackageFiles.length > 0 &&
        globMatchSome(changedPackageFiles, configResult.config.changedFilePatterns)
      );
    })
    .map((pkg) => pkg.packageJson.name);

  const releasePlan = assembleReleasePlan(
    await Promise.all(changesetPromises),
    packages,
    configResult.config,
    await preStatePromise,
  );

  return {
    changedPackages,
    releasePlan,
  };
};
