import { ValidationError } from "@changesets/errors";
import type { ReleasePlan, ComprehensiveRelease, VersionType } from "@changesets/types";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { captureException } from "@sentry/node";
import humanId from "human-id";
import markdownTable from "markdown-table";
import type { Probot, Context } from "probot";

import { getChangedPackages } from "./get-changed-packages.ts";

const getReleasePlanMessage = (releasePlan: ReleasePlan | null) => {
  if (!releasePlan) return "";

  const publishableReleases = releasePlan.releases.filter(
    (release): release is ComprehensiveRelease & { type: Exclude<VersionType, "none"> } =>
      release.type !== "none",
  );

  let table = markdownTable([
    ["Name", "Type"],
    ...publishableReleases.map((release) => {
      return [
        release.name,
        {
          major: "Major",
          minor: "Minor",
          patch: "Patch",
        }[release.type],
      ];
    }),
  ]);

  return `<details><summary>This PR includes ${
    releasePlan.changesets.length > 0
      ? `changesets to release ${
          publishableReleases.length === 1 ? "1 package" : `${publishableReleases.length} packages`
        }`
      : "no changesets"
  }</summary>

  ${
    publishableReleases.length > 0
      ? table
      : "When changesets are added to this PR, you'll see the packages that this PR includes changesets for and the associated semver types"
  }

</details>`;
};

const getAbsentMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null,
) => `###  ⚠️  No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

${getReleasePlanMessage(releasePlan)}

[Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add a changeset to this PR](${addChangesetUrl})

`;

const getApproveMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null,
) => `###  🦋  Changeset detected

Latest commit: ${commitSha}

**The changes in this PR will be included in the next version bump.**

${getReleasePlanMessage(releasePlan)}

Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/main/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add another changeset to this PR](${addChangesetUrl})

`;

const getNewChangesetTemplate = (changedPackages: ReadonlyArray<string>, title: string) =>
  encodeURIComponent(`---
${changedPackages.map((pkgName) => `"${pkgName}": patch`).join("\n")}
---

${title}
`);

export type PRContext = EmitterWebhookEvent<"pull_request.opened" | "pull_request.synchronize"> &
  Omit<Context, keyof EmitterWebhookEvent>;

const getCommentId = (
  context: PRContext,
  params: { repo: string; owner: string; issue_number: number },
) =>
  context.octokit.issues.listComments(params).then((commentsResponse) => {
    const changesetBotComment = commentsResponse.data.find(
      // TODO: find what the current user is in some way or something
      (comment) =>
        comment.user?.login === "changeset-bot[bot]" ||
        comment.user?.login === "changesets-test-bot[bot]",
    );
    return changesetBotComment ? changesetBotComment.id : null;
  });

const hasChangesetBeenAdded = (
  changedFilesPromise: ReturnType<PRContext["octokit"]["pulls"]["listFiles"]>,
) =>
  changedFilesPromise.then((filesResponse) =>
    filesResponse.data.some(
      (file) =>
        file.status === "added" &&
        /^\.changeset\/.+\.md$/.test(file.filename) &&
        file.filename !== ".changeset/README.md",
    ),
  );

export default (app: Probot) => {
  void app.auth();
  app.log("Yay, the app was loaded!");

  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    if (context.payload.pull_request.head.ref.startsWith("changeset-release")) {
      return;
    }

    let errFromFetchingChangedFiles = "";

    try {
      let number = context.payload.number;

      let repo = {
        repo: context.payload.repository.name,
        owner: context.payload.repository.owner.login,
      };

      const latestCommitSha = context.payload.pull_request.head.sha;
      let changedFilesPromise = context.octokit.pulls.listFiles({
        ...repo,
        pull_number: number,
      });

      const [commentId, hasChangeset, { changedPackages, releasePlan }] = await Promise.all([
        // We know the comment won't exist on opened events
        // ok, well like technically that's wrong
        // but reducing time is nice here so that
        // deploying this doesn't cost money
        context.payload.action === "synchronize"
          ? getCommentId(context, { ...repo, issue_number: number })
          : undefined,
        hasChangesetBeenAdded(changedFilesPromise),
        getChangedPackages({
          repo: context.payload.pull_request.head.repo.name,
          owner: context.payload.pull_request.head.repo.owner.login,
          ref: context.payload.pull_request.head.ref,
          changedFiles: changedFilesPromise.then((filesResponse) =>
            filesResponse.data.map(({ filename }) => filename),
          ),
          octokit: context.octokit,
          installationToken: (
            await (await app.auth()).apps.createInstallationAccessToken({
              installation_id: context.payload.installation!.id,
            })
          ).data.token,
        }).catch((err) => {
          if (err instanceof ValidationError) {
            errFromFetchingChangedFiles = `<details><summary>💥 An error occurred when fetching the changed packages and changesets in this PR</summary>\n\n\`\`\`\n${err.message}\n\`\`\`\n\n</details>\n`;
          } else {
            console.error(err);
            captureException(err);
          }
          return {
            changedPackages: ["@fake-scope/fake-pkg"],
            releasePlan: null,
          };
        }),
      ]);

      let addChangesetUrl = `${context.payload.pull_request.head.repo.html_url}/new/${
        context.payload.pull_request.head.ref
      }?filename=.changeset/${humanId({
        separator: "-",
        capitalize: false,
      })}.md&value=${getNewChangesetTemplate(changedPackages, context.payload.pull_request.title)}`;

      let prComment = {
        ...repo,
        issue_number: number,
        body:
          (hasChangeset
            ? getApproveMessage(latestCommitSha, addChangesetUrl, releasePlan)
            : getAbsentMessage(latestCommitSha, addChangesetUrl, releasePlan)) +
          errFromFetchingChangedFiles,
      };

      if (typeof commentId === "number") {
        await context.octokit.issues.updateComment({
          ...prComment,
          comment_id: commentId,
        });
        return;
      }
      await context.octokit.issues.createComment(prComment);
    } catch (err) {
      console.error(err);
      throw err;
    }
  });
};
