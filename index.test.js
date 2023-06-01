const nock = require("nock");
const { Probot, ProbotOctokit } = require("probot");
const outdent = require("outdent");

const changesetBot = require(".");

const pullRequestOpen = require("./test/fixtures/pull_request.opened");
const pullRequestSynchronize = require("./test/fixtures/pull_request.synchronize");
const releasePullRequestOpen = require("./test/fixtures/release_pull_request.opened");

nock.disableNetConnect();

describe("changeset-bot", () => {
  let probot;

  beforeEach(async() => {
    probot = new Probot({
      githubToken: "test",
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });

    changesetBot.default(probot)
  });

  beforeEach(() => {
    nock("https://raw.githubusercontent.com")
        .get("/changesets/bot/test/package.json")
        .reply(200, {})

    nock("https://raw.githubusercontent.com")
        .get("/changesets/bot/test/.changeset/config.json")
        .reply(200, {})

    nock("https://api.github.com")
        .get("/repos/changesets/bot/git/trees/test?recursive=1")
        .reply(200, {
          tree: [],
        })

    nock("https://api.github.com")
        .post("/app/installations/2462428/access_tokens")
        .reply(200, [])
  })

  it("should add a comment when there is no comment", async () => {
    nock("https://api.github.com")
      .get("/repos/changesets/bot/pulls/2/files")
      .reply(200, [
        { filename: ".changeset/something/changes.md", status: "added" }
      ]);

    // checks and creates a comment
    nock("https://api.github.com")
      .post("/repos/changesets/bot/issues/2/comments", body => {
        expect(body.body).toContain("Changeset detected")
        expect(body.comment_id).toBeUndefined()
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen
    });
  });

  it("should update a comment when there is a comment", async () => {
    const commentId = 123

    nock("https://api.github.com")
      .get("/repos/changesets/bot/pulls/2/files")
      .reply(200, [
        { filename: ".changeset/something/changes.md", status: "added" }
      ]);

    // get comments for an issue
    nock("https://api.github.com")
        .get("/repos/changesets/bot/issues/2/comments")
        .reply(200, [{
          id: commentId,
          user: {
            login: "changeset-bot[bot]"
          }
        }]);

    // update comments for an issue
    nock("https://api.github.com")
      .patch(`/repos/changesets/bot/issues/comments/${commentId}`, body => {
        expect(body.body).toContain("Changeset detected")
        return true;
      })
    .reply(200);

    await probot.receive({
      name: "pull_request",
      payload: pullRequestSynchronize
    });
  });

  it.skip("should show correct message if there is a changeset", async () => {
    nock("https://api.github.com")
      .get("/repos/repos/changesets/bot/issues/2/comments")
      .reply(200, []);

    nock("https://api.github.com")
      .get("/repos/changesets/bot/pulls/2/files")
      .reply(200, [
        { filename: ".changeset/something/changes.md", status: "added" }
      ]);

    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/pulls/1/commits")
      .reply(200, [{ sha: "ABCDE" }]);

    nock("https://api.github.com")
      .post("/repos/changesets/bot/issues/2/comments", ({ body }) => {
        expect(body).toEqual(outdent`
          ###  🦋  Changeset is good to go

          Latest commit: ABCDE

          **We got this.**

          Not sure what this means? [Click here  to learn what changesets are](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).`);
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen
    });
  });

  it("should show correct message if there is no changeset", async () => {
    nock("https://api.github.com")
      .get("/repos/changesets/bot/issues/2/comments")
      .reply(200, []);

    nock("https://api.github.com")
      .get("/repos/changesets/bot/pulls/2/files")
      .reply(200, [{ filename: "index.js", status: "added" }]);

    nock("https://api.github.com")
      .post("/repos/changesets/bot/issues/2/comments", ({ body }) => {
          expect(body).toContain(outdent`
          ###  ⚠️  No Changeset found

          Latest commit: c4d7edfd758bd44f7d4264fb55f6033f56d79540

          Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

          <details><summary>This PR includes no changesets</summary>

            When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types

          </details>

          [Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).
          `);
          expect(body).toMatch(/\[Click here if you're a maintainer who wants to add a changeset to this PR]\(https:\/\/github\.com\/changesets\/bot\/new\/test\?filename=\.changeset/)
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen
    });
  });

  it("shouldn't add a comment to a release pull request", async () => {
      nock("https://api.github.com")
          .post()
          .reply(() => {
              // shouldn't reach this, but if it does - let it fail
              expect(true).toBe(false);
          });

    await probot.receive({
      name: "pull_request",
      payload: releasePullRequestOpen
    });
  });
});
