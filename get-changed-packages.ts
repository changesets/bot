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
import { safeLoad } from "js-yaml";
import micromatch from "micromatch";
import fetch from "node-fetch";
import type { ProbotOctokit } from "probot";

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
  changedFiles: Array<string> | Promise<Array<string>>;
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

  interface PackageJSON extends ChangesetPackageJSON {
    workspaces?: Array<string> | { packages: Array<string> };
    bolt?: { workspaces: Array<string> };
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
    if (item.path.endsWith("/package.json")) {
      const dirPath = nodePath.dirname(item.path);
      potentialWorkspaceDirectories.push(dirPath);
    } else if (item.path === "pnpm-workspace.yaml") {
      isPnpm = true;
    } else if (item.path === ".changeset/pre.json") {
      preStatePromise = fetchJsonFile(".changeset/pre.json");
    } else if (
      item.path !== ".changeset/README.md" &&
      item.path.startsWith(".changeset") &&
      item.path.endsWith(".md") &&
      changedFiles.includes(item.path)
    ) {
      const res = /\.changeset\/([^.]+)\.md/.exec(item.path);
      if (!res) {
        throw new Error("could not get name from changeset filename");
      }
      const id = res[1];

      changesetPromises.push(
        fetchTextFile(item.path).then((text) => ({ ...parseChangeset(text), id })),
      );
    }
  }
  let tool:
    | {
        tool: Tool;
        globs: Array<string>;
      }
    | undefined;

  if (isPnpm) {
    interface PnpmWorkspace {
      packages: Array<string>;
    }

    const pnpmWorkspaceContent = await fetchTextFile("pnpm-workspace.yaml");
    const pnpmWorkspace = safeLoad(pnpmWorkspaceContent) as PnpmWorkspace;

    tool = {
      globs: pnpmWorkspace.packages,
      tool: "pnpm",
    };
  } else {
    const rootPackageJsonContent = await rootPackageJsonContentsPromise;

    if (rootPackageJsonContent.workspaces) {
      if (Array.isArray(rootPackageJsonContent.workspaces)) {
        tool = {
          globs: rootPackageJsonContent.workspaces,
          tool: "yarn",
        };
      } else {
        tool = {
          globs: rootPackageJsonContent.workspaces.packages,
          tool: "yarn",
        };
      }
    } else if (rootPackageJsonContent.bolt && rootPackageJsonContent.bolt.workspaces) {
      tool = {
        globs: rootPackageJsonContent.bolt.workspaces,
        tool: "bolt",
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
    if (!Array.isArray(tool.globs) || !tool.globs.every((x) => typeof x === "string")) {
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

  const rawConfig = await rawConfigPromise;

  const releasePlan = assembleReleasePlan(
    await Promise.all(changesetPromises),
    packages,
    parseConfig(rawConfig, packages),
    await preStatePromise,
  );

  return {
    changedPackages: (packages.tool === "root"
      ? packages.packages
      : packages.packages.filter((pkg) =>
          changedFiles.some((changedFile) => changedFile.startsWith(`${pkg.dir}/`)),
        )
    ).map((x) => x.packageJson.name),
    releasePlan,
  };
};
