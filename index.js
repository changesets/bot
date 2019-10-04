const humanId = require("human-id");

const getAbsentMessage = (commitSha, addChangesetUrl) => `###  💥  No Changeset

Latest commit: ${commitSha}

Merging this PR will not cause any packages to be released. If these changes should not cause updates to packages in this repo, this is fine 🙂

**If these changes should be published to npm, you need to add a changeset.**

[Click here to learn what changesets are, and how to add one](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add a changeset to this PR](${addChangesetUrl})

`;

const getApproveMessage = (
  commitSha,
  addChangesetUrl
) => `###  🦋  Changeset is good to go

Latest commit: ${commitSha}

**We got this.**

Not sure what this means? [Click here  to learn what changesets are](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add another changeset to this PR](${addChangesetUrl})

`;

const getCommentId = (context, params) =>
  context.github.pullRequests.listComments(params).then(comments => {
    const changesetBotComment = comments.data.find(
      // TODO: find what the current user is in some way or something
      comment =>
        comment.user.login === "changeset-bot[bot]" ||
        comment.user.login === "changesets-test-bot[bot]"
    );
    return changesetBotComment ? changesetBotComment.id : null;
  });

const getChangesetId = (context, params) =>
  context.github.pullRequests.listFiles(params).then(files => {
    const changesetFiles = files.data.filter(
      file => file.filename.startsWith(".changeset") && file.status === "added"
    );
    return changesetFiles.length > 0;
  });

const getLatestCommit = (context, params) =>
  context.github.pullRequests.listCommits(params).then(commits => {
    return commits.data.pop();
  });

module.exports = app => {
  app.log("Yay, the app was loaded!");

  // Get an express router to expose new HTTP endpoints
  // Healthcheck
  const router = app.route("/");
  router.get("/healthcheck", (req, res) => {
    res.send("OK");
  });

  app.on(["pull_request.opened", "pull_request.synchronize"], async context => {
    try {
      const params = context.issue();

      let queryStuff = {
        pull_number: context.payload.number,
        owner: context.payload.repository.name,
        repository: context.payload.repository.owner.login
      };

      let addChangesetUrl = `${
        context.payload.pull_request.head.repo.html_url
      }/new/${
        context.payload.pull_request.head.ref
      }?filename=.changeset/${humanId({
        separator: "-",
        capitalize: false
      })}.md`;

      const latestCommitSha = context.payload.pull_request.head.sha;

      const [commentId, hasChangeset] = await Promise.all([
        // we know the comment won't exist on opened events
        // ok, well like technically that's wrong
        // but reducing time is nice here so that
        // deploying this doesn't cost money
        context.payload.action === "synchronize"
          ? getCommentId(context, queryStuff)
          : null,
        getChangesetId(context, queryStuff)
      ]);

      let prComment;
      if (!hasChangeset) {
        prComment = context.issue({
          comment_id: commentId,
          body: getAbsentMessage(latestCommitSha, addChangesetUrl)
        });
      } else {
        prComment = context.issue({
          comment_id: commentId,
          body: getApproveMessage(latestCommitSha, addChangesetUrl)
        });
      }

      if (commentId) {
        return context.github.issues.updateComment(prComment);
      }
      return context.github.issues.createComment(prComment);
    } catch (err) {
      console.error(err);
      throw err;
    }
  });
};
