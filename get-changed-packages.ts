import nodePath from "path";
import micromatch from "micromatch";
import { Workspace } from "@changesets/types";
import { Octokit } from "probot";
import fetch from "node-fetch";
import { safeLoad } from "js-yaml";

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
  let isPnpm = false;
  for (let item of tree.data.tree) {
    if (item.path.endsWith("/package.json")) {
      let dirPath = nodePath.dirname(item.path);
      potentialWorkspaceDirectories.push(dirPath);
      itemsByDirPath.set(dirPath, item);
    }
    if (item.path === "pnpm-workspace.yaml") {
      isPnpm = true;
    }
  }
  let rootPackageJsonContent = await rootPackageJsonContentsPromise;
  let globs;

  if (isPnpm) {
    globs = safeLoad(await fetchTextFile("pnpm-workspace.yaml")).packages;
  } else {
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
  }

  if (!(Array.isArray(globs) && globs.every(x => typeof x === "string"))) {
    throw new Error("globs are not valid");
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
