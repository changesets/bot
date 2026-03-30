import { generateKeyPairSync } from "crypto";

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Probot } from "probot";

import changesetBot from "../index";
import pullRequestOpen from "./fixtures/pull_request.opened.json";
import pullRequestSynchronize from "./fixtures/pull_request.synchronize.json";
import releasePullRequestOpen from "./fixtures/release_pull_request.opened.json";

const server = setupServer();

// Probot validates the privateKey locally
//  so we must generate a valid key
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
  privateKeyEncoding: {
    type: "pkcs8",
    format: "pem",
  },
});

const githubRepoBase = "https://api.github.com/repos/changesets/bot";
const githubRawContentBase = "https://raw.githubusercontent.com/changesets/bot";
const githubAppBase = "https://api.github.com/app/installations";

const githubAuthRoute = http.post(
  `${githubAppBase}/:installationId/access_tokens`,
  () => HttpResponse.json({ token: "test" }),
);

const repositoryContentRoutes = [
  // get repo tree (used in getChangedPackages)
  http.get(`${githubRepoBase}/git/trees/test`, () =>
    HttpResponse.json({ tree: [{ path: "package.json" }] }),
  ),

  // get package.json content
  http.get(`${githubRawContentBase}/test/package.json`, () =>
    HttpResponse.json({ name: "test", workspaces: ["packages/*"] }),
  ),

  // get changeset config
  http.get(`${githubRawContentBase}/test/.changeset/config.json`, () =>
    HttpResponse.json([{}]),
  ),
];

describe("changeset-bot", () => {
  let probot: Probot;

  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  beforeEach(() => {
    probot = new Probot({ appId: 123, privateKey });

    probot.load(changesetBot);
  });

  it("adds a comment when there is no comment", async () => {
    const createCommentSpy = vi.fn();

    // Mock all GitHub endpoints used by the handler
    server.use(
      githubAuthRoute,

      ...repositoryContentRoutes,

      // list comments
      http.get(`${githubRepoBase}/issues/2/comments`, () =>
        HttpResponse.json([]),
      ),

      // list changed files
      http.get(`${githubRepoBase}/pulls/2/files`, () =>
        HttpResponse.json([
          { filename: ".changeset/something-changed.md", status: "added" },
        ]),
      ),

      // get latest commits
      http.get(`${githubRepoBase}/pulls/2/commits`, () =>
        HttpResponse.json([{ sha: "ABCDE" }]),
      ),

      // create comment
      http.post(`${githubRepoBase}/issues/2/comments`, async ({ request }) => {
        const body = await request.json();
        createCommentSpy(body);
        return new HttpResponse({}, { status: 200 });
      }),
    );

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    // Assert a comment was created
    expect(createCommentSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        body: expect.stringContaining("###  🦋  Changeset detected"),
      }),
    );
  });

  it("should update a comment when there is a comment", async () => {
    const updateCommentSpy = vi.fn();

    server.use(
      githubAuthRoute,

      ...repositoryContentRoutes,

      // list comments
      http.get(`${githubRepoBase}/issues/2/comments`, () =>
        HttpResponse.json([
          {
            id: 7,
            user: { login: "changeset-bot[bot]" },
          },
        ]),
      ),

      // list changed files
      http.get(`${githubRepoBase}/pulls/2/files`, () =>
        HttpResponse.json([
          { filename: ".changeset/something/changes.md", status: "added" },
        ]),
      ),

      // get latest commits
      http.get(`${githubRepoBase}/pulls/2/commits`, () =>
        HttpResponse.json([{ sha: "ABCDE" }]),
      ),

      // update comments
      http.patch(`${githubRepoBase}/issues/comments/7`, async ({ request }) => {
        const body = await request.json();
        updateCommentSpy(body);
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await probot.receive({
      name: "pull_request",
      payload: pullRequestSynchronize,
    } as never);

    expect(updateCommentSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        issue_number: 2,
      }),
    );
  });

  it("should show correct message if there is a changeset", async () => {
    const updateCommentSpy = vi.fn();

    server.use(
      githubAuthRoute,

      ...repositoryContentRoutes,

      http.get(`${githubRepoBase}/issues/2/comments`, () =>
        HttpResponse.json([]),
      ),

      http.get(`${githubRepoBase}/pulls/2/files`, () =>
        HttpResponse.json([
          { filename: ".changeset/something/changes.md", status: "added" },
        ]),
      ),

      http.get(`${githubRepoBase}/pulls/2/commits`, () =>
        HttpResponse.json([{ sha: "ABCDE" }]),
      ),

      http.post(`${githubRepoBase}/issues/2/comments`, async ({ request }) => {
        const body = await request.json();
        updateCommentSpy(body);
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    expect(updateCommentSpy).toHaveBeenCalledTimes(1);

    const updateCommentResponse = updateCommentSpy.mock.calls[0][0];
    expect(updateCommentResponse).toHaveProperty("body");

    // can't use snapshot since changeset filename is different on each run
    expect(updateCommentResponse.body).toContain("###  🦋  Changeset detected");
    expect(updateCommentResponse.body).toContain(
      "Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540",
    );
    expect(updateCommentResponse.body).toContain(
      "**The changes in this PR will be included in the next version bump.**",
    );
  });

  it("should show correct message if there is no changeset", async () => {
    const updateCommentSpy = vi.fn();

    server.use(
      githubAuthRoute,

      ...repositoryContentRoutes,

      // list comments
      http.get(`${githubRepoBase}/issues/2/comments`, () =>
        HttpResponse.json([]),
      ),

      // list changed files
      http.get(`${githubRepoBase}/pulls/2/files`, () =>
        HttpResponse.json([{ filename: "index.js", status: "added" }]),
      ),

      // get latest commits
      http.get(`${githubRepoBase}/pulls/2/commits`, () =>
        HttpResponse.json([{ sha: "ABCDE" }]),
      ),

      // update comment
      http.post(`${githubRepoBase}/issues/2/comments`, async ({ request }) => {
        const body = await request.json();
        updateCommentSpy(body);
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    expect(updateCommentSpy).toHaveBeenCalledTimes(1);

    const updateCommentResponse = updateCommentSpy.mock.calls[0][0];
    expect(updateCommentResponse).toHaveProperty("body");

    // can't use snapshot since changeset filename is different on each run
    expect(updateCommentResponse.body).toContain("###  ⚠️  No Changeset found");
    expect(updateCommentResponse.body).toContain(
      "Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540",
    );
    expect(updateCommentResponse.body).toContain(
      "Merging this PR will not cause a version bump for any packages.",
    );
  });

  it("shouldn't add a comment to a release pull request", async () => {
    const requestSpy = vi.fn();

    server.use(
      githubAuthRoute,
      http.all("https://api.github.com/*", requestSpy),
    );

    await probot.receive({
      name: "pull_request",
      payload: releasePullRequestOpen,
    } as never);

    expect(requestSpy).not.toHaveBeenCalled();
  });
});
