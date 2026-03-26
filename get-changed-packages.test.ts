import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MockedFunction } from "vitest";
import { getChangedPackages } from "./get-changed-packages";

import fetch from "node-fetch";
import micromatch from "micromatch";
import assembleReleasePlan from "@changesets/assemble-release-plan";
import { parse as parseConfig } from "@changesets/config";
import parseChangeset from "@changesets/parse";
import { safeLoad } from "js-yaml";
import type { ComprehensiveRelease } from "@changesets/types";

vi.mock("node-fetch", () => ({
  default: vi.fn(),
}));

vi.mock("micromatch", () => ({
  default: vi.fn(),
}));

vi.mock("@changesets/assemble-release-plan", () => ({
  default: vi.fn(),
}));

vi.mock("@changesets/config", () => ({
  parse: vi.fn(),
}));

vi.mock("@changesets/parse", () => ({
  default: vi.fn(),
}));

vi.mock("js-yaml", () => ({
  safeLoad: vi.fn(),
}));

const fetchMock = vi.mocked(fetch) as unknown as MockedFunction<
  () => {
    json?: Response["json"];
    text?: Response["text"];
  }
>;
const micromatchMock = vi.mocked(micromatch);
const assembleReleasePlanMock = vi.mocked(assembleReleasePlan);
const parseConfigMock = vi.mocked(parseConfig);
const parseChangesetMock = vi.mocked(parseChangeset);
const safeLoadMock = vi.mocked(safeLoad);

describe("getChangedPackages", () => {
  let octokit: any;

  beforeEach(() => {
    vi.clearAllMocks();

    octokit = {
      git: {
        getTree: vi.fn(),
      },
    };

    assembleReleasePlanMock.mockResolvedValue({
      releases: [] as Array<ComprehensiveRelease>,
      changesets: [],
      preState: undefined,
    });
    parseConfigMock.mockReturnValue({});
    parseChangesetMock.mockReturnValue({
      summary: "test",
      releases: [],
    });
  });

  function mockFetchJson(data: { name: string }) {
    fetchMock.mockResolvedValue({
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    } satisfies Pick<Response, "json" | "text"> as never);
  }

  function mockFetchText(text: string) {
    fetchMock.mockResolvedValue({
      json: () => Promise.reject("Invalid json"),
      text: () => Promise.resolve(text),
    });
  }

  it("returns root package when no workspace tool is detected", async () => {
    mockFetchJson({ name: "root-package" });

    octokit.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });

    const result = await getChangedPackages({
      owner: "owner",
      repo: "repo",
      ref: "main",
      changedFiles: [],
      octokit,
      installationToken: "token",
    });

    expect(result.changedPackages).toEqual(["root-package"]);
    expect(assembleReleasePlanMock).toHaveBeenCalled();
  });

  it("detects yarn workspaces (array form) and filters changed packages", async () => {
    // root package.json
    fetchMock
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            workspaces: ["packages/*"],
          }),
      })
      // config.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      })
      // package A
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ name: "pkg-a" }),
      })
      // package B
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ name: "pkg-b" }),
      });

    octokit.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "packages/a/package.json" },
          { path: "packages/b/package.json" },
        ],
      },
    });

    micromatchMock.mockReturnValue(["packages/a", "packages/b"]);

    const result = await getChangedPackages({
      owner: "owner",
      repo: "repo",
      ref: "main",
      changedFiles: ["packages/a/index.ts"],
      octokit,
      installationToken: "token",
    });

    expect(result.changedPackages).toEqual(["pkg-a"]);
  });

  it("detects pnpm workspace via pnpm-workspace.yaml", async () => {
    fetchMock
      // root package.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      })
      // config.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      })
      // pnpm-workspace.yaml
      .mockResolvedValueOnce({
        text: () => Promise.resolve("packages:\n  - packages/*"),
      })
      // package.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ name: "pkg-a" }),
      });

    safeLoadMock.mockReturnValue({
      packages: ["packages/*"],
    });

    octokit.git.getTree.mockResolvedValue({
      data: {
        tree: [
          { path: "pnpm-workspace.yaml" },
          { path: "packages/a/package.json" },
        ],
      },
    });

    micromatchMock.mockReturnValue(["packages/a"]);

    const result = await getChangedPackages({
      owner: "owner",
      repo: "repo",
      ref: "main",
      changedFiles: ["packages/a/file.ts"],
      octokit,
      installationToken: "token",
    });

    expect(result.changedPackages).toEqual(["pkg-a"]);
  });

  it("parses changeset files when changed", async () => {
    fetchMock
      // root package.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ name: "root" }),
      })
      // config.json
      .mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      })
      // changeset file
      .mockResolvedValueOnce({
        text: () => Promise.resolve("changeset content"),
      });

    octokit.git.getTree.mockResolvedValue({
      data: {
        tree: [{ path: ".changeset/abc123.md" }],
      },
    });

    const result = await getChangedPackages({
      owner: "owner",
      repo: "repo",
      ref: "main",
      changedFiles: [".changeset/abc123.md"],
      octokit,
      installationToken: "token",
    });
    
    expect(parseChangesetMock).toHaveBeenCalledWith("changeset content");
    expect(assembleReleasePlanMock).toHaveBeenCalled();
    expect(result.changedPackages).toEqual(["root"]);
  });

  it("throws if globs are invalid", async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: () =>
          Promise.resolve({
            workspaces: 123, // invalid
          }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({}),
      });

    octokit.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });

    await expect(
      getChangedPackages({
        owner: "owner",
        repo: "repo",
        ref: "main",
        changedFiles: [],
        octokit,
        installationToken: "token",
      }),
    ).rejects.toThrow("globs are not valid");
  });

  it("throws if fetch fails", async ({ onTestFinished }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      errorSpy.mockClear();
    });
    fetchMock.mockRejectedValue(new Error("network error"));

    octokit.git.getTree.mockResolvedValue({
      data: { tree: [] },
    });

    await expect(
      getChangedPackages({
        owner: "owner",
        repo: "repo",
        ref: "main",
        changedFiles: [],
        octokit,
        installationToken: "token",
      }),
    ).rejects.toThrow("an error occurred when fetching files");
  });
});
