import { describe, it, expect, beforeEach, vi } from "vitest";

import * as getChangedPackagesModule from "./get-changed-packages";
import changesetBot from "./index";

import pullRequestOpen from "./test/fixtures/pull_request.opened.json";
import pullRequestSynchronize from "./test/fixtures/pull_request.synchronize.json";
import releasePullRequestOpen from "./test/fixtures/release_pull_request.opened.json";

describe("changeset-bot", () => {
  let handler;
  let getChangedPackagesSpy;

  const createOctokitMock = () => ({
    issues: {
      listComments: vi.fn().mockResolvedValue({ data: [] }),
      createComment: vi.fn().mockResolvedValue({}),
      updateComment: vi.fn().mockResolvedValue({}),
    },
    pulls: {
      listFiles: vi.fn().mockResolvedValue({
        data: [
          { filename: ".changeset/something/changes.md", status: "added" },
        ],
      }),
      listCommits: vi.fn().mockResolvedValue({ data: [{ sha: "ABCDE" }] }),
    },
  });

  beforeEach(() => {
    vi.restoreAllMocks();

    // Default spy implementation (can be overridden per test)
    getChangedPackagesSpy = vi
      .spyOn(getChangedPackagesModule, "getChangedPackages")
      .mockResolvedValue({
        changedPackages: ["@fake-scope/fake-pkg"],
        releasePlan: null,
      });

    const app = {
      auth: vi.fn().mockResolvedValue({
        apps: {
          createInstallationAccessToken: vi.fn().mockResolvedValue({
            data: { token: "fake-token" },
          }),
        },
      }),
      log: vi.fn(),
      on: vi.fn(),
    };

    changesetBot(app);

    const call = app.on.mock.calls.find((c) => {
      const events = c[0];
      return (
        Array.isArray(events) && events.some((e) => e.includes("pull_request"))
      );
    });

    if (!call) throw new Error("pull_request handler not registered");
    handler = call[1];
  });

  it("exports a handler", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("should add a comment when there is no previous bot comment and changeset exists", async () => {
    const octokit = createOctokitMock();

    await handler({ payload: pullRequestOpen, octokit });

    expect(octokit.issues.createComment).toHaveBeenCalled();
    expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        issue_number: pullRequestOpen.number,
        body: expect.stringContaining("Changeset detected"),
      }),
    );
  });

  it("should update an existing bot comment on synchronize", async () => {
    const octokit = createOctokitMock();

    octokit.issues.listComments.mockResolvedValue({
      data: [{ id: 7, user: { login: "changeset-bot[bot]" } }],
    });

    await handler({ payload: pullRequestSynchronize, octokit });

    expect(octokit.issues.updateComment).toHaveBeenCalled();
    expect(octokit.issues.updateComment).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        comment_id: 7,
        body: expect.stringContaining("Changeset detected"),
      }),
    );
  });

  it("does not comment on release pull requests", async () => {
    const octokit = createOctokitMock();

    await handler({ payload: releasePullRequestOpen, octokit });

    expect(octokit.issues.listComments).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.issues.updateComment).not.toHaveBeenCalled();
  });

  it("handles getChangedPackages failure gracefully", async ({
    onTestFinished,
  }) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => {
      errorSpy.mockClear();
    });

    const octokit = createOctokitMock();

    getChangedPackagesSpy.mockRejectedValue(new Error("boom"));

    await handler({ payload: pullRequestOpen, octokit });

    expect(octokit.issues.createComment).toHaveBeenCalled();
  });
});
