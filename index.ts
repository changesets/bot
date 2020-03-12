// @ts-ignore
import humanId from "human-id";
import { Application, Context, Octokit } from "probot";
import Webhooks from "@octokit/webhooks";
import { getChangedPackages } from "./get-changed-packages";
import { ReleasePlan } from "@changesets/types";
import markdownTable from "markdown-table";

const getReleasePlanMessage = (releasePlan: ReleasePlan | null) => {
  if (!releasePlan) return "";

  let table = markdownTable([
    ["Name", "Type"],
    ...releasePlan.releases.map(x => {
      return [
        x.name,
        {
          major: "Major",
          minor: "Minor",
          patch: "Patch"
        }[x.type]
      ];
    })
  ]);

  return `<details><summary>This PR includes ${
    releasePlan.changesets.length
      ? `changesets to release ${
          releasePlan.releases.length === 1
            ? "1 package"
            : `${releasePlan.releases.length} packages`
        }`
      : "no changesets"
  }</summary>

  ${
    releasePlan.releases.length
      ? table
      : "When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types"
  }

</details>`;
};

const getAbsentMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `###  💥  No Changeset

Latest commit: ${commitSha}

Merging this PR will not cause any packages to be released. If these changes should not cause updates to packages in this repo, this is fine 🙂

**If these changes should be published to npm, you need to add a changeset.**

${getReleasePlanMessage(releasePlan)}

[Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add a changeset to this PR](${addChangesetUrl})

`;

const getApproveMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `###  🦋  Changeset is good to go

Latest commit: ${commitSha}

**We got this.**

${getReleasePlanMessage(releasePlan)}

Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add another changeset to this PR](${addChangesetUrl})

`;

const getNewChangesetTemplate = (changedPackages: string[], title: string) =>
  encodeURIComponent(`---
${changedPackages.map(x => `"${x}": patch`).join("\n")}
---

${title}
`);

type PRContext = Context<Webhooks.WebhookPayloadPullRequest>;

const getCommentId = (
  context: PRContext,
  params: { repo: string; owner: string; issue_number: number }
) =>
  context.github.issues.listComments(params).then(comments => {
    const changesetBotComment = comments.data.find(
      // TODO: find what the current user is in some way or something
      comment =>
        comment.user.login === "changeset-bot[bot]" ||
        comment.user.login === "changesets-test-bot[bot]"
    );
    return changesetBotComment ? changesetBotComment.id : null;
  });

const getChangesetId = (
  changedFilesPromise: Promise<
    Octokit.Response<Octokit.PullsListFilesResponse>
  >,
  params: { repo: string; owner: string; pull_number: number }
) =>
  changedFilesPromise.then(files =>
    files.data.some(
      file => file.filename.startsWith(".changeset") && file.status === "added"
    )
  );

async function fetchJsonFile(context: PRContext, path: string) {
  let output = await context.github.repos.getContents({
    owner: context.payload.pull_request.head.repo.owner.login,
    repo: context.payload.pull_request.head.repo.name,
    path,
    ref: context.payload.pull_request.head.ref
  });
  // @ts-ignore
  let buffer = Buffer.from(output.data.content, "base64");
  return JSON.parse(buffer.toString("utf8"));
}

export default (app: Application) => {
  app.auth();
  app.log("Yay, the app was loaded!");

  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    // @ts-ignore
    async (context: PRContext) => {
      context;
      if (
        context.payload.pull_request.head.ref.startsWith("changeset-release")
      ) {
        return;
      }

      try {
        let number = context.payload.number;

        let repo = {
          repo: context.payload.repository.name,
          owner: context.payload.repository.owner.login
        };

        const latestCommitSha = context.payload.pull_request.head.sha;

        let changedFilesPromise = context.github.pulls.listFiles({
          ...repo,
          pull_number: number
        });

        console.log(context.payload);

        const [
          commentId,
          hasChangeset,
          { changedPackages, releasePlan }
        ] = await Promise.all([
          // we know the comment won't exist on opened events
          // ok, well like technically that's wrong
          // but reducing time is nice here so that
          // deploying this doesn't cost money
          context.payload.action === "synchronize"
            ? getCommentId(context, { ...repo, issue_number: number })
            : undefined,
          getChangesetId(changedFilesPromise, { ...repo, pull_number: number }),
          getChangedPackages({
            repo: context.payload.pull_request.head.repo.name,
            owner: context.payload.pull_request.head.repo.owner.login,
            ref: context.payload.pull_request.head.ref,
            changedFiles: changedFilesPromise.then(x =>
              x.data.map(x => x.filename)
            ),
            octokit: context.github,
            installationToken: await app.app.getInstallationAccessToken({
              installationId: (context.payload as any).installation.id
            })
          }).catch(err => {
            console.error(err);
            return {
              changedPackages: ["@fake-scope/fake-pkg"],
              releasePlan: null
            };
          })
        ] as const);

        let addChangesetUrl = `${
          context.payload.pull_request.head.repo.html_url
        }/new/${
          context.payload.pull_request.head.ref
        }?filename=.changeset/${humanId({
          separator: "-",
          capitalize: false
        })}.md&value=${getNewChangesetTemplate(
          changedPackages,
          context.payload.pull_request.title
        )}`;

        let prComment = {
          ...repo,
          comment_id: commentId,
          issue_number: number,
          body: hasChangeset
            ? getApproveMessage(latestCommitSha, addChangesetUrl, releasePlan)
            : getAbsentMessage(latestCommitSha, addChangesetUrl, releasePlan)
        };

        if (prComment.comment_id != null) {
          // @ts-ignore
          return context.github.issues.updateComment(prComment);
        }
        return context.github.issues.createComment(prComment);
      } catch (err) {
        console.error(err);
        throw err;
      }
    }
  );
};
