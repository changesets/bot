import nodePath from "path";
import assembleReleasePlan from "@changesets/assemble-release-plan";
import { parse as parseConfig } from "@changesets/config";
import parseChangeset from "@changesets/parse";
import type {
  NewChangeset,
  PreState,
  WrittenConfig,
  PackageJSON as ChangesetPackageJSON,
} from "@changesets/types";
import type { Packages, Tool } from "@manypkg/get-packages";
import jsYaml from "js-yaml";
import micromatch from "micromatch";
import type { ProbotOctokit } from "probot";

import { isChangeset } from "./is-changeset.ts";

interface PackageJSON extends ChangesetPackageJSON {
  workspaces?: ReadonlyArray<string> | { packages: ReadonlyArray<string> };
  bolt?: { workspaces: ReadonlyArray<string> };
}

interface PnpmWorkspace {
  packages: ReadonlyArray<string>;
}

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
    return fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`, {
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
    const jsonContent = await fetchJsonFile(pkgPath + "/package.json");
    return {
      dir: pkgPath,
      packageJson: jsonContent as PackageJSON,
    };
  }

  const rootPackageJsonContentsPromise: Promise<PackageJSON> = fetchJsonFile("package.json");
  const rawConfigPromise: Promise<WrittenConfig> = fetchJsonFile(".changeset/config.json");

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
  const changedFiles = await changedFilesPromise;

  for (const item of tree.data.tree) {
    if (!item.path) {
      continue;
    }
    if (nodePath.basename(item.path) === "package.json") {
      const dirPath = nodePath.dirname(item.path);
      potentialWorkspaceDirectories.push(dirPath);
    } else if (item.path === "pnpm-workspace.yaml") {
      isPnpm = true;
    } else if (item.path === ".changeset/pre.json") {
      preStatePromise = fetchJsonFile(".changeset/pre.json");
    } else if (changedFiles.includes(item.path) && isChangeset(item.path)) {
      const res = /\.changeset\/([^.]+)\.md/.exec(item.path);
      if (!res) {
        throw new Error("could not get name from changeset filename");
      }
      const id = res[1];

      changesetPromises.push(
        fetchTextFile(item.path).then((text) => ({
          ...parseChangeset(text),
          id,
        })),
      );
    }
  }
  let tool:
    | {
        tool: Tool;
        globs: ReadonlyArray<string>;
      }
    | undefined;

  if (isPnpm) {
    const pnpmWorkspaceContent = await fetchTextFile("pnpm-workspace.yaml");
    const pnpmWorkspace = jsYaml.safeLoad(pnpmWorkspaceContent) as PnpmWorkspace;

    if (pnpmWorkspace.packages) {
      tool = {
        tool: "pnpm",
        globs: pnpmWorkspace.packages,
      };
    }
  } else {
    const rootPackageJsonContent = await rootPackageJsonContentsPromise;

    if (rootPackageJsonContent.workspaces) {
      if (isArray(rootPackageJsonContent.workspaces)) {
        tool = {
          tool: "yarn",
          globs: rootPackageJsonContent.workspaces,
        };
      } else {
        tool = {
          tool: "yarn",
          globs: rootPackageJsonContent.workspaces.packages,
        };
      }
    } else if (rootPackageJsonContent.bolt && rootPackageJsonContent.bolt.workspaces) {
      tool = {
        tool: "bolt",
        globs: rootPackageJsonContent.bolt.workspaces,
      };
    }
  }

  const rootPackageJsonContent = await rootPackageJsonContentsPromise;

  const packages: Packages = {
    root: {
      dir: "/",
      packageJson: rootPackageJsonContent,
    },
    tool: tool ? tool.tool : "root",
    packages: [],
  };

  if (tool) {
    if (
      !Array.isArray(tool.globs) ||
      !tool.globs.every((glob: unknown) => typeof glob === "string")
    ) {
      throw new Error("globs are not valid: " + JSON.stringify(tool.globs));
    }
    const matches = micromatch(potentialWorkspaceDirectories, tool.globs);

    packages.packages = await Promise.all(matches.map((dir) => getPackage(dir)));
  } else {
    packages.packages.push(packages.root);
  }
  if (hasErrored) {
    throw new Error("an error occurred when fetching files");
  }

  const releasePlan = assembleReleasePlan(
    await Promise.all(changesetPromises),
    packages,
    parseConfig(await rawConfigPromise, packages),
    await preStatePromise,
  );

  return {
    changedPackages: (packages.tool === "root"
      ? packages.packages
      : packages.packages.filter((pkg) =>
          changedFiles.some((changedFile) => changedFile.startsWith(`${pkg.dir}/`)),
        )
    ).map((pkg) => pkg.packageJson.name),
    releasePlan,
  };
};
