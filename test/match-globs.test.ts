import { describe, expect, it } from "vitest";
import { matchGlobs } from "../match-globs.ts";

const paths = ["/repo/packages/a", "/repo/packages/private/special"];

describe("matchGlobs", () => {
  it.each(["packages/*/", "packages//*/", "/repo/packages/*", "../repo/packages/*"])(
    "normalizes workspace glob %s like tinyglobby",
    (glob) => {
      expect(matchGlobs(paths, [glob], { cwd: "/repo" })).toEqual(["/repo/packages/a"]);
    },
  );

  it("keeps excluded workspaces excluded after a later positive pattern", () => {
    expect(
      matchGlobs(paths, ["packages/**", "!packages/private/**", "packages/private/special"], {
        cwd: "/repo",
      }),
    ).toEqual(["/repo/packages/a"]);
  });
});
