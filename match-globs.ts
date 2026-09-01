import nodePath from "node:path";
import picomatch from "picomatch";

const PARENT_DIRECTORY = /^(\/?\.\.)+/;
const ESCAPING_BACKSLASHES = /\\(?=[()[\]{}!*+?@|])/g;

// Adapted from tinyglobby 0.2.16's POSIX escaping and pattern splitting helpers.
// https://github.com/SuperchupuDev/tinyglobby/blob/577920259c91f5603fab3dbfa599a83bbb14a27a/src/utils.ts#L132-L140
// https://github.com/SuperchupuDev/tinyglobby/blob/577920259c91f5603fab3dbfa599a83bbb14a27a/src/utils.ts#L164-L183
const POSIX_UNESCAPED_GLOB_SYMBOLS = /(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\()|\\(?![()[\]{}!*+?@|]))/g;

function escapePosixPath(path: string): string {
  return path.replace(POSIX_UNESCAPED_GLOB_SYMBOLS, "\\$&");
}

function splitPattern(pattern: string): Array<string> {
  const result = picomatch.scan(pattern, { parts: true });
  return result.parts?.length ? result.parts : [pattern];
}

// Adapted from tinyglobby 0.2.16. Crawler-root calculations are omitted because
// this helper filters paths from a Git tree instead of traversing a filesystem.
// https://github.com/SuperchupuDev/tinyglobby/blob/577920259c91f5603fab3dbfa599a83bbb14a27a/src/patterns.ts#L7-L65
function normalizePattern(pattern: string, cwd: string): string {
  let result = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
  const escapedCwd = escapePosixPath(cwd);

  result = nodePath.posix.isAbsolute(result.replace(ESCAPING_BACKSLASHES, ""))
    ? nodePath.posix.relative(escapedCwd, result)
    : nodePath.posix.normalize(result);

  const parentDir = PARENT_DIRECTORY.exec(result)?.[0];
  if (parentDir) {
    const parts = splitPattern(result);
    const parentCount = (parentDir.length + 1) / 3;
    const cwdParts = escapedCwd.split("/");
    let matchingParents = 0;

    while (
      matchingParents < parentCount &&
      parts[matchingParents + parentCount] ===
        cwdParts[cwdParts.length + matchingParents - parentCount]
    ) {
      result =
        result.slice(0, (parentCount - matchingParents - 1) * 3) +
          result.slice(
            (parentCount - matchingParents) * 3 + parts[matchingParents + parentCount].length + 1,
          ) || ".";
      matchingParents++;
    }
  }

  return result;
}

// Pattern classification and matching follow tinyglobby 0.2.16.
// https://github.com/SuperchupuDev/tinyglobby/blob/577920259c91f5603fab3dbfa599a83bbb14a27a/src/patterns.ts#L68-L98
// https://github.com/SuperchupuDev/tinyglobby/blob/577920259c91f5603fab3dbfa599a83bbb14a27a/src/crawler.ts#L18-L31
export function matchGlobs(
  paths: ReadonlyArray<string>,
  globs: ReadonlyArray<string>,
  { cwd }: { cwd: string },
): Array<string> {
  const matchPatterns: Array<string> = [];
  // tinyglobby prunes node_modules while crawling. Match descendants explicitly
  // because all candidate paths have already been collected from the Git tree.
  const ignorePatterns: Array<string> = ["**/node_modules", "**/node_modules/**"];

  for (const glob of globs) {
    if (!glob) continue;

    if (glob[0] !== "!" || glob[1] === "(") {
      matchPatterns.push(normalizePattern(glob, cwd));
    } else if (glob[1] !== "!" || glob[2] === "(") {
      ignorePatterns.push(normalizePattern(glob.slice(1), cwd));
    }
  }

  const matchOptions = { posix: true };
  const matches = picomatch(matchPatterns, matchOptions);
  const ignores = picomatch(ignorePatterns, matchOptions);

  return paths.filter((path) => {
    const relativePath = nodePath.posix.relative(cwd, path) || ".";
    return matches(relativePath) && !ignores(relativePath);
  });
}
