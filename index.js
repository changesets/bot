// let addChangesetUrl = `${
//   github.context.payload.pull_request!.head.repo.html_url
// }/new/${
//   github.context.payload.pull_request!.head.ref
// }?filename=.changeset/${humanId({
//   separator: "-",
//   capitalize: false
// })}.md`;

const getAbsentMessage = commitSha => `###  💥  No Changeset

Latest commit: ${commitSha}

Merging this PR will not cause any packages to be released. If these changes should not cause updates to packages in this repo, this is fine 🙂

**If these changes should be published to npm, you need to add a changeset.**

[Click here to learn what changesets are, and how to add one](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).

`;

const getApproveMessage = commitSha => `###  🦋  Changeset is good to go

Latest commit: ${commitSha}

**We got this.**

Not sure what this means? [Click here  to learn what changesets are](https://github.com/Noviny/changesets/blob/master/docs/adding-a-changeset.md).`;

const getCommentId = (context, params) =>
  context.github.issues.listComments(params).then(comments => {
    const changesetBotComment = comments.data.find(
      comment => comment.user.login === "changeset-bot[bot]"
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
    const params = context.issue();

    console.log(params);

    const commentId = await getCommentId(context, params);
    const hasChangeset = await getChangesetId(context, params);
    const latestCommit = await getLatestCommit(context, params);

    let prComment;
    if (!hasChangeset) {
      prComment = context.issue({
        comment_id: commentId,
        body: getAbsentMessage(latestCommit.sha)
      });
    } else {
      prComment = context.issue({
        comment_id: commentId,
        body: getApproveMessage(latestCommit.sha)
      });
    }

    if (commentId) {
      return context.github.issues.updateComment(prComment);
    }
    return context.github.issues.createComment(prComment);
  });
};
