import nodePath from "path";
import micromatch from "micromatch";
import { Octokit } from "probot";
import fetch from "node-fetch";
import { safeLoad } from "js-yaml";
import { Packages, Tool } from "@manypkg/get-packages";
import assembleReleasePlan from "@changesets/assemble-release-plan";
import { PreState, Config, NewChangeset } from "@changesets/types";
import parseChangeset from "@changesets/parse";

type Sha = string & { ___sha: string };

export let getChangedPackages = async ({
  owner,
  repo,
  ref,
  changedFiles: changedFilesPromise,
  octokit,
  installationToken
}: {
  owner: string;
  repo: string;
  ref: string;
  changedFiles: string[] | Promise<string[]>;
  octokit: Octokit;
  installationToken: string;
}) => {
    let encodedCredentials = Buffer.from(
      `x-access-token:${installationToken}`
    ).toString("base64");

    function fetchFile(path: string) {
      return fetch(
        `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
        {
          headers: {
            Authorization: `Basic ${encodedCredentials}`
          }
        }
      );
    }

    function fetchJsonFile(path: string) {
      return fetchFile(path).then(x => x.json());
    }

    function fetchTextFile(path: string) {
      return fetchFile(path).then(x => x.text());
    }

    async function getPackage(pkgPath: string) {
      let jsonContent = await fetchJsonFile(pkgPath + "/package.json");
      return {
        packageJson: jsonContent,
        dir: pkgPath
      };
    }

    let rootPackageJsonContentsPromise = fetchJsonFile("package.json");
    let configPromise: Promise<Config> = fetchJsonFile(
      ".changeset/config.json"
    );

    let tree = await octokit.git.getTree({
      owner,
      repo,
      recursive: "1",
      tree_sha: ref
    });

    let preStatePromise: Promise<PreState> | undefined;
    let changesetPromises: Promise<NewChangeset>[] = [];
    let itemsByDirPath = new Map<string, { path: string; sha: Sha }>();
    let potentialWorkspaceDirectories: string[] = [];
    let isPnpm = false;
    for (let item of tree.data.tree) {
      if (item.path.endsWith("/package.json")) {
        let dirPath = nodePath.dirname(item.path);
        potentialWorkspaceDirectories.push(dirPath);
        itemsByDirPath.set(dirPath, item);
      } else if (item.path === "pnpm-workspace.yaml") {
        isPnpm = true;
      } else if (item.path === ".changeset/pre.json") {
        preStatePromise = fetchJsonFile(".changeset/pre.json");
      } else if (
        item.path !== ".changeset/README.md" &&
        item.path.startsWith(".changeset") &&
        item.path.endsWith(".md")
      ) {
        let res = /\.changeset\/([^\.]+)\.md/.exec(item.path);
        if (!res) {
          throw new Error("could not get name from changeset filename");
        }
        let id = res[1];
        changesetPromises.push(
          fetchTextFile(item.path).then(text => {
            return { ...parseChangeset(text), id };
          })
        );
      }
    }
    let tool:
      | {
          tool: Tool;
          globs: string[];
        }
      | undefined;

    if (isPnpm) {
      tool = {
        tool: "pnpm",
        globs: safeLoad(await fetchTextFile("pnpm-workspace.yaml")).packages
      };
    } else {
      let rootPackageJsonContent = await rootPackageJsonContentsPromise;

      if (rootPackageJsonContent.workspaces) {
        if (!Array.isArray(rootPackageJsonContent.workspaces)) {
          tool = {
            tool: "yarn",
            globs: rootPackageJsonContent.workspaces.packages
          };
        } else {
          tool = {
            tool: "yarn",
            globs: rootPackageJsonContent.workspaces
          };
        }
      } else if (
        rootPackageJsonContent.bolt &&
        rootPackageJsonContent.bolt.workspaces
      ) {
        tool = {
          tool: "bolt",
          globs: rootPackageJsonContent.bolt.workspaces
        };
      }
    }

    if (
      !tool ||
      !(
        Array.isArray(tool.globs) &&
        tool.globs.every(x => typeof x === "string")
      )
    ) {
      throw new Error("globs are not valid");
    }

    let rootPackageJsonContent = await rootPackageJsonContentsPromise;

    let packages: Packages = {
      root: {
        dir: "/",
        packageJson: rootPackageJsonContent
      },
      tool: tool.tool,
      packages: []
    };

    if (tool) {
      let matches = micromatch(potentialWorkspaceDirectories, tool.globs);

      packages.packages = await Promise.all(
        matches.map(dir => getPackage(dir))
      );
    } else {
      packages.packages.push(packages.root);
    }

    const releasePlan = assembleReleasePlan(
      await Promise.all(changesetPromises),
      packages,
      await configPromise,
      await preStatePromise
    );

    let changedFiles = await changedFilesPromise;

    return {
      changedPackages: packages.packages
        .filter(pkg =>
          changedFiles.some(changedFile => changedFile.includes(pkg.dir))
        )
        .map(x => x.packageJson.name),
      releasePlan
    };
  }
};
