import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Probot, ProbotOctokit } from "probot";
import { aroundEach, beforeAll, describe, it } from "vitest";

import changesetBot, { PRContext } from "../index";
import pullRequestOpen from "./fixtures/pull_request.opened.json";
import pullRequestSynchronize from "./fixtures/pull_request.synchronize.json";
import releasePullRequestOpen from "./fixtures/release_pull_request.opened.json";

// TODO: it might be possible to remove this if improvements to `Array.isArray` ever land
// related thread: github.com/microsoft/TypeScript/issues/36554
function isArray<T>(
  arg: T | {},
): arg is T extends readonly any[]
  ? unknown extends T
    ? never
    : readonly any[]
  : any[] {
  return Array.isArray(arg);
}

function setupMswServer() {
  const server = setupServer();
  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
    return () => {
      server.close();
    };
  });
  aroundEach((runTest) => server.boundary(runTest)());
  return server;
}

const server = setupMswServer();

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
const githubAppBase = "https://api.github.com/app/installations";

const normalizeCommentBody = (body: string) =>
  body.replace(
    /filename=\.changeset\/[^)&\s]+?\.md/g,
    "filename=.changeset/<CHANGESET_FILE>.md",
  );

type ChangedFile = {
  status: "added";
  content: string;
};

type FileState = string | ChangedFile;

type CommentState = {
  id: number;
  user: { login: string };
};

type PrState = {
  files: Record<string, FileState>;
  comments?: CommentState[];
};

type RecordedRequest = {
  method: string;
  path: string;
  body?: unknown;
};

function usePrState(server: ReturnType<typeof setupServer>, state: PrState) {
  const requests: RecordedRequest[] = [];

  const recordRequest = async (
    request: Request,
    mapper?: (body: unknown) => unknown,
  ) => {
    let body: unknown;

    if (!["GET", "HEAD"].includes(request.method)) {
      const text = await request.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (mapper) {
        body = mapper(body);
      }
    }

    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body,
    });
  };

  server.use(
    http.post(
      `${githubAppBase}/:installationId/access_tokens`,
      async ({ request }) => {
        await recordRequest(request);
        return HttpResponse.json({ token: "test" });
      },
    ),
    http.get(`${githubRepoBase}/git/trees/:ref`, async ({ request }) => {
      await recordRequest(request);
      return HttpResponse.json({
        tree: Object.keys(state.files).map((path) => ({ path })),
        truncated: false,
      });
    }),
    http.get(`${githubRepoBase}/issues/2/comments`, async ({ request }) => {
      await recordRequest(request);
      return HttpResponse.json(state.comments ?? []);
    }),
    http.get(`${githubRepoBase}/pulls/2/files`, async ({ request }) => {
      await recordRequest(request);
      // we only use those 2 fields right now, so we don't bother with the rest of the type
      const changedFiles: Pick<
        Awaited<
          ReturnType<PRContext["octokit"]["pulls"]["listFiles"]>
        >["data"][number],
        "filename" | "status"
      >[] = [];
      for (const [filename, file] of Object.entries(state.files)) {
        if (typeof file !== "string") {
          changedFiles.push({
            filename,
            status: file.status,
          });
        }
      }
      return HttpResponse.json(changedFiles);
    }),
    http.get(
      "https://raw.githubusercontent.com/changesets/bot/:ref/:path+",
      async ({ request, params }) => {
        await recordRequest(request);

        const path = isArray(params.path) ? params.path.join("/") : params.path;
        assert(path);
        const file = state.files[path];

        if (file == null) {
          return new HttpResponse("Not found", { status: 404 });
        }

        const content = typeof file === "string" ? file : file.content;

        if (path.endsWith(".json")) {
          return HttpResponse.json(JSON.parse(content));
        }

        return new HttpResponse(content);
      },
    ),
    http.post(`${githubRepoBase}/issues/2/comments`, async ({ request }) => {
      await recordRequest(request, (body) => {
        assert(
          !!body &&
            typeof body === "object" &&
            "body" in body &&
            typeof body.body === "string",
        );
        return { ...body, body: normalizeCommentBody(body.body) };
      });
      return HttpResponse.json({});
    }),
    http.patch(
      `${githubRepoBase}/issues/comments/:commentId`,
      async ({ request }) => {
        await recordRequest(request, (body) => {
          assert(
            !!body &&
              typeof body === "object" &&
              "body" in body &&
              typeof body.body === "string",
          );
          return { ...body, body: normalizeCommentBody(body.body) };
        });
        return HttpResponse.json({});
      },
    ),
  );

  return { requests };
}

const baseFiles = {
  "package.json": JSON.stringify({
    name: "test",
    workspaces: ["packages/*"],
  }),
  ".changeset/config.json": JSON.stringify({}),
};

function setupProbot(testId: string) {
  // Probot reuses some global state for Octokit instances for the same installation id.
  // That makes MSW mocking unreliable as requests scheduled by one test can be actually dispatched from the context of another test.
  const TestOctokit = ProbotOctokit.defaults({
    throttle: {
      id: `test-${testId}`,
    },
  });
  const probot = new Probot({ appId: 123, privateKey, Octokit: TestOctokit });
  changesetBot(probot);
  return probot;
}

describe.concurrent("changeset-bot", () => {
  it("adds a comment when there is no comment", async ({ expect, task }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        ...baseFiles,
        ".changeset/something-changed.md": {
          status: "added",
          content: "---\n---\n",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  🦋  Changeset detected

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      **The changes in this PR will be included in the next version bump.**

      <details><summary>This PR includes changesets to release 0 packages</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add another changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("should update a comment when there is a comment", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        ...baseFiles,
        ".changeset/something/changes.md": {
          status: "added",
          content: "---\n---\n",
        },
      },
      comments: [
        {
          id: 7,
          user: { login: "changeset-bot[bot]" },
        },
      ],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestSynchronize,
    } as never);

    const commentRequests = requests.filter(
      (request) =>
        request.path.includes("/comments") && request.method === "PATCH",
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  🦋  Changeset detected

      Latest commit: 10a63035fe8155b86b1060c89873e9a03c6fe673

      **The changes in this PR will be included in the next version bump.**

      <details><summary>This PR includes changesets to release 0 packages</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add another changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%0A---%0A%0Athing%0A)

      ",
            "issue_number": 2,
          },
          "method": "PATCH",
          "path": "/repos/changesets/bot/issues/comments/7",
        },
      ]
    `);
  });

  it("should show correct message if there is a changeset", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        ...baseFiles,
        ".changeset/something/changes.md": {
          status: "added",
          content: "---\n---\n",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  🦋  Changeset detected

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      **The changes in this PR will be included in the next version bump.**

      <details><summary>This PR includes changesets to release 0 packages</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add another changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("should show correct message if there is no changeset", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        ...baseFiles,
        "index.js": {
          status: "added",
          content: "console.log('test');",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );
    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  ⚠️  No Changeset found

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

      <details><summary>This PR includes no changesets</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      [Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add a changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("uses the root package when no workspace tool is detected", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        "package.json": JSON.stringify({
          name: "root-package",
        }),
        ".changeset/config.json": JSON.stringify({}),
        "src/index.ts": {
          status: "added",
          content: "export {};",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  ⚠️  No Changeset found

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

      <details><summary>This PR includes no changesets</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      [Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add a changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%22root-package%22%3A%20patch%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("includes only changed yarn workspace packages in the add-changeset link", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        "package.json": JSON.stringify({
          name: "test",
          workspaces: ["packages/*"],
        }),
        ".changeset/config.json": JSON.stringify({}),
        "packages/a/package.json": JSON.stringify({
          name: "pkg-a",
        }),
        "packages/b/package.json": JSON.stringify({
          name: "pkg-b",
        }),
        "packages/a/index.ts": {
          status: "added",
          content: "export const a = true;",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  ⚠️  No Changeset found

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

      <details><summary>This PR includes no changesets</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      [Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add a changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%22pkg-a%22%3A%20patch%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("detects pnpm workspaces when building the add-changeset link", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        "package.json": JSON.stringify({
          name: "test",
        }),
        ".changeset/config.json": JSON.stringify({}),
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/a/package.json": JSON.stringify({
          name: "pkg-a",
        }),
        "packages/a/file.ts": {
          status: "added",
          content: "export const a = true;",
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  ⚠️  No Changeset found

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

      <details><summary>This PR includes no changesets</summary>

        When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

      </details>

      [Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add a changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%22pkg-a%22%3A%20patch%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("shows release details when a changed changeset parses into a release plan", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: {
        ...baseFiles,
        "packages/a/package.json": JSON.stringify({
          name: "pkg-a",
          version: "1.0.0",
        }),
        ".changeset/abc123.md": {
          status: "added",
          content: `---
"pkg-a": patch
---

add feature
`,
        },
      },
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen,
    } as never);

    const commentRequests = requests.filter((request) =>
      request.path.includes("/comments"),
    );

    expect(commentRequests).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "body": "###  🦋  Changeset detected

      Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

      **The changes in this PR will be included in the next version bump.**

      <details><summary>This PR includes changesets to release 1 package</summary>

        | Name  | Type  |
      | ----- | ----- |
      | pkg-a | Patch |

      </details>

      Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

      [Click here if you're a maintainer who wants to add another changeset to this PR](https://github.com/changesets/bot/new/test?filename=.changeset/<CHANGESET_FILE>.md&value=---%0A%0A---%0A%0Athing%0A)

      ",
          },
          "method": "POST",
          "path": "/repos/changesets/bot/issues/2/comments",
        },
      ]
    `);
  });

  it("shouldn't add a comment to a release pull request", async ({
    expect,
    task,
  }) => {
    const probot = setupProbot(task.id);
    const { requests } = usePrState(server, {
      files: baseFiles,
      comments: [],
    });

    await probot.receive({
      name: "pull_request",
      payload: releasePullRequestOpen,
    } as never);

    expect(requests).toHaveLength(0);
  });
});
