import nodePath from "path";
import micromatch from "micromatch";
import { Workspace } from "@changesets/types";
import { Octokit } from "probot";
import fetch from "node-fetch";

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

  function fetchJsonFile(path: string) {
    return fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
      {
        headers: {
          Authorization: `Basic ${encodedCredentials}`
        }
      }
    ).then(x => x.json());
  }

  // I'm assuming that a workspace will only be requested once per call to getReleasePlanFromGitHub
  // If that's an incorrect assumption, this should change
  async function getWorkspace(pkgPath: string) {
    let jsonContent = await fetchJsonFile(pkgPath + "/package.json");
    return {
      name: jsonContent.name,
      config: jsonContent,
      dir: pkgPath
    };
  }

  let rootPackageJsonContentsPromise = fetchJsonFile("package.json");

  let tree = await octokit.git.getTree({
    owner,
    repo,
    recursive: "1",
    tree_sha: ref
  });

  let itemsByDirPath = new Map<string, { path: string; sha: Sha }>();
  let potentialWorkspaceDirectories: string[] = [];
  for (let item of tree.data.tree) {
    if (item.path.endsWith("/package.json")) {
      let dirPath = nodePath.dirname(item.path);
      potentialWorkspaceDirectories.push(dirPath);
      itemsByDirPath.set(dirPath, item);
    }
  }
  let rootPackageJsonContent = await rootPackageJsonContentsPromise;
  let globs;
  if (rootPackageJsonContent.workspaces) {
    if (!Array.isArray(rootPackageJsonContent.workspaces)) {
      globs = rootPackageJsonContent.workspaces.packages;
    } else {
      globs = rootPackageJsonContent.workspaces;
    }
  } else if (
    rootPackageJsonContent.bolt &&
    rootPackageJsonContent.bolt.workspaces
  ) {
    globs = rootPackageJsonContent.bolt.workspaces;
  }
  let workspaces: Workspace[] = [];
  let rootWorkspace = {
    dir: "/",
    config: rootPackageJsonContent,
    name: rootPackageJsonContent.name
  };
  if (globs) {
    let changedFiles = await changedFilesPromise;
    let matches = micromatch(
      potentialWorkspaceDirectories,
      globs
    ).filter(match =>
      changedFiles.some(changedFile => changedFile.includes(match))
    );

    workspaces = await Promise.all(matches.map(dir => getWorkspace(dir)));
  } else {
    workspaces = [rootWorkspace];
  }

  return { changedPackages: workspaces.map(x => x.name) };
};
