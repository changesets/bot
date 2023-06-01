const nock = require("nock");
const { Probot, ProbotOctokit } = require("probot");
const outdent = require("outdent");
const pino = require("pino");
const Stream = require("stream");

const changesetBot = require(".");

const pullRequestOpen = require("./test/fixtures/pull_request.opened");
const pullRequestSynchronize = require("./test/fixtures/pull_request.synchronize");
const releasePullRequestOpen = require("./test/fixtures/release_pull_request.opened");

nock.disableNetConnect();

const output = []

const streamLogsToOutput = new Stream.Writable({ objectMode: true });
streamLogsToOutput._write = (object, encoding, done) => {
  output.push(JSON.parse(object));
  done();
};

/*
Oh god none of these tests work - we should really do something about having this tested
*/
describe("changeset-bot", () => {
  let probot;
  let app

  beforeEach(async() => {
    probot = new Probot({
      githubToken: "test",
      appId: 123,
      privateKey: 123,
      log: pino(streamLogsToOutput),
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });

    app = changesetBot.default(probot)

    // just return a test token
    app.app = () => "test.ts";
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

    await app.receive({
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

  it("should show correct message if there is a changeset", async () => {
    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/issues/1/comments")
      .reply(200, []);

    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/pulls/1/files")
      .reply(200, [
        { filename: ".changeset/something/changes.md", status: "added" }
      ]);

    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/pulls/1/commits")
      .reply(200, [{ sha: "ABCDE" }]);

    nock("https://api.github.com")
      .post("/repos/pyu/testing-things/issues/1/comments", ({ body }) => {
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
      .get("/repos/pyu/testing-things/issues/1/comments")
      .reply(200, []);

    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/pulls/1/files")
      .reply(200, [{ filename: "index.js", status: "added" }]);

    nock("https://api.github.com")
      .get("/repos/pyu/testing-things/pulls/1/commits")
      .reply(200, [{ sha: "ABCDE" }]);

    nock("https://api.github.com")
      .post("/repos/pyu/testing-things/issues/1/comments", ({ body }) => {
        expect(body).toEqual(outdent`
          ###  💥  No Changeset

          Latest commit: ABCDE

          Merging this PR will not cause any packages to be released. If these changes should not cause updates to packages in this repo, this is fine 🙂

          **If these changes should be published to npm, you need to add a changeset.**

          [Click here to learn what changesets are, and how to add one](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).`);
        return true;
      })
      .reply(200);

    await probot.receive({
      name: "pull_request",
      payload: pullRequestOpen
    });
  });

  it("shouldn't add a comment to a release pull request", async () => {
    nock("https://api.github.com").reply(() => {
      // shouldn't reach this, but if it does - let it fail
      expect(true).toBe(false);
    });

    await probot.receive({
      name: "pull_request",
      payload: releasePullRequestOpen
    });
  });
});
