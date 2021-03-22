// @ts-ignore
import humanId from "human-id";
import { Application, Context } from "probot";
import Webhooks from "@octokit/webhooks";
import { getChangedPackages } from "./get-changed-packages";
import {
  ReleasePlan,
  ComprehensiveRelease,
  VersionType,
} from "@changesets/types";
import markdownTable from "markdown-table";
import { captureException } from "@sentry/node";
import { ValidationError } from "@changesets/errors";
import issueParser from "issue-parser";

const getReleasePlanMessage = (releasePlan: ReleasePlan | null) => {
  if (!releasePlan) return "";

  let table = markdownTable([
    ["Name", "Type"],
    ...releasePlan.releases
      .filter(
        (
          x
        ): x is ComprehensiveRelease & { type: Exclude<VersionType, "none"> } =>
          x.type !== "none"
      )
      .map((x) => {
        return [
          x.name,
          {
            major: "Major",
            minor: "Minor",
            patch: "Patch",
          }[x.type],
        ];
      }),
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
) => `###  ⚠️  No Changeset found

Latest commit: ${commitSha}

Merging this PR will not cause a version bump for any packages. If these changes should not result in a new version, you're good to go. **If these changes should result in a version bump, you need to add a changeset.**

${getReleasePlanMessage(releasePlan)}

[Click here to learn what changesets are, and how to add one](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add a changeset to this PR](${addChangesetUrl})

`;

const getApproveMessage = (
  commitSha: string,
  addChangesetUrl: string,
  releasePlan: ReleasePlan | null
) => `###  🦋  Changeset detected

Latest commit: ${commitSha}

**The changes in this PR will be included in the next version bump.**

${getReleasePlanMessage(releasePlan)}

Not sure what this means? [Click here  to learn what changesets are](https://github.com/changesets/changesets/blob/master/docs/adding-a-changeset.md).

[Click here if you're a maintainer who wants to add another changeset to this PR](${addChangesetUrl})

`;

const getReleaseMessage = (
  html_url: string,
  name: string
) => `###  🦋  This work has been released in release version: ${name}

Release link: ${html_url}
`;

const getNewChangesetTemplate = (changedPackages: string[], title: string) =>
  encodeURIComponent(`---
${changedPackages.map((x) => `"${x}": patch`).join("\n")}
---

${title}
`);

type PRContext = Context<Webhooks.EventPayloads.WebhookPayloadPullRequest>;
type ReleaseContext = Context<Webhooks.EventPayloads.WebhookPayloadRelease>;

const getSearchQueries = (base: string, commits: string[]) => {
  return commits.reduce((searches, commit) => {
    const lastSearch = searches[searches.length - 1];

    if (lastSearch && lastSearch.length + commit.length <= 256 - 1) {
      searches[searches.length - 1] = `${lastSearch}+hash:${commit}`;
    } else {
      searches.push(`${base}+hash:${commit}`);
    }

    return searches;
  }, [] as string[]);
};

const getCommentId = (
  context: PRContext,
  params: { repo: string; owner: string; issue_number: number }
) =>
  context.github.issues.listComments(params).then((comments) => {
    const changesetBotComment = comments.data.find(
      // TODO: find what the current user is in some way or something
      (comment) =>
        comment.user.login === "changeset-bot[bot]" ||
        comment.user.login === "changesets-test-bot[bot]"
    );
    return changesetBotComment ? changesetBotComment.id : null;
  });

const getChangesetId = (
  changedFilesPromise: ReturnType<PRContext["github"]["pulls"]["listFiles"]>,
  params: { repo: string; owner: string; pull_number: number }
) =>
  changedFilesPromise.then((files) =>
    files.data.some(
      (file) =>
        file.filename.startsWith(".changeset") && file.status === "added"
    )
  );

export default (app: Application) => {
  app.auth();
  app.log("Yay, the app was loaded!");

  /* Comment on released Pull Requests/Issues  */
  app.on("release.published", async (context: ReleaseContext) => {
    /*
    Here are the following steps to retrieve the released PRs and issues.
  
      1. Retrieve the tag associated with the release
      2. Take the commit sha associated with the tag
      3. Retrieve all the commits starting from the tag commit sha
      4. Retrieve the PRs with commits sha matching the release commits
      5. Map through the list of commits and the list of PRs to
         find commit message or PRs body that closes an issue and
         get the issue number.
      6. Create a comment for each issue and PR
    */

    const release = context.payload.release;
    const { html_url, tag_name } = release;
    const repo = {
      repo: context.payload.repository.name,
      owner: context.payload.repository.owner.login,
    };

    let tagPage = 0;
    let tagFound = false;
    let tagCommitSha = "";

    /* 1 */
    while (!tagFound) {
      await context.github.repos
        .listTags({
          ...repo,
          per_page: 100,
          page: tagPage,
        })
        .then(({ data }) => {
          const tag = data.find((el) => el.name === tag_name);
          if (tag) {
            tagFound = true;
            /* 2 */
            tagCommitSha = tag.commit.sha;
          }
          tagPage += 1;
        })
        .catch((err) => console.warn(err));
    }

    /* 3 */
    const commits = await context.github.repos
      .listCommits({
        ...repo,
        sha: tagCommitSha,
      })
      .then(({ data }) => data);

    const shas = commits.map(({ sha }) => sha);

    /* Build a seach query to retrieve pulls with commit hashes.
     *  example: repo:<OWNER>/<REPO>+type:pr+is:merged+hash:<FIRST_COMMIT_HASH>+hash:<SECOND_COMMIT_HASH>...
     */
    const searchQueries = getSearchQueries(
      `repo:${repo.owner}/${repo.repo}+type:pr+is:merged`,
      shas
    ).map(
      async (q) =>
        (await context.github.search.issuesAndPullRequests({ q })).data.items
    );

    const queries = await (await Promise.all(searchQueries)).flat();

    const queriesSet = queries.map((el) => el.number);

    const filteredQueries = queries.filter(
      (el, i) => queriesSet.indexOf(el.number) === i
    );

    /* 4 */
    const pulls = await filteredQueries.filter(
      async ({ number }) =>
        (
          await context.github.pulls.listCommits({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: number,
          })
        ).data.find(({ sha }) => shas.includes(sha)) ||
        shas.includes(
          (
            await context.github.pulls.get({
              owner: repo.owner,
              repo: repo.repo,
              pull_number: number,
            })
          ).data.merge_commit_sha
        )
    );

    const parser = issueParser("github");

    /* 5 */
    const issues = [
      ...pulls.map((pr) => pr.body),
      ...commits.map(({ commit }) => commit.message),
    ].reduce((issues, message) => {
      return message
        ? issues.concat(
            parser(message)
              .actions.close.filter(
                (action) =>
                  action.slug === null ||
                  action.slug === undefined ||
                  action.slug === `${repo.owner}/${repo.repo}`
              )
              .map((action) => ({ number: Number.parseInt(action.issue, 10) }))
          )
        : issues;
    }, [] as { number: number }[]);

    /* 6 */
    await Promise.all(
      [...new Set([...pulls, ...issues].map(({ number }) => number))].map(
        async (number) => {
          const issueComment = {
            ...repo,
            issue_number: number,
            body: getReleaseMessage(html_url, tag_name),
          };

          context.github.issues.createComment(issueComment);
        }
      )
    );
  });

  app.on(
    ["pull_request.opened", "pull_request.synchronize"],
    async (context: PRContext) => {
      if (
        context.payload.pull_request.head.ref.startsWith("changeset-release")
      ) {
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
        let changedFilesPromise = context.github.pulls.listFiles({
          ...repo,
          pull_number: number,
        });

        console.log(context.payload);

        const [
          commentId,
          hasChangeset,
          { changedPackages, releasePlan },
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
            changedFiles: changedFilesPromise.then((x) =>
              x.data.map((x) => x.filename)
            ),
            octokit: context.github,
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
        ] as const);

        let addChangesetUrl = `${
          context.payload.pull_request.head.repo.html_url
        }/new/${
          context.payload.pull_request.head.ref
        }?filename=.changeset/${humanId({
          separator: "-",
          capitalize: false,
        })}.md&value=${getNewChangesetTemplate(
          changedPackages,
          context.payload.pull_request.title
        )}`;

        let prComment = {
          ...repo,
          comment_id: commentId,
          issue_number: number,
          body:
            (hasChangeset
              ? getApproveMessage(latestCommitSha, addChangesetUrl, releasePlan)
              : getAbsentMessage(
                  latestCommitSha,
                  addChangesetUrl,
                  releasePlan
                )) + errFromFetchingChangedFiles,
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
