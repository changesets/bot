# changeset-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that Bot to detect [changesets](https://github.com/atlassian/changesets) in PRs

## Install the bot at https://github.com/apps/changeset-bot



This bot will comment on PRs saying that either a user might need to add a changeset(note that not PRs changing things like documentation generally don't need a changeset)or say that the PR is good and already has a changeset.

Sometimes, a contributor won't add a changeset to a PR but you might want to merge in the PR without having to wait on them to add it. To address this, this bot adds a link with the filename pre-filled to add a changeset so all you have to do is write the changeset and click commit.

When writing the changeset, it should look something like this with the packages that are being released in the YAML front matter with associated semver bump types and the summary of the changes in markdown.
```markdown
---
'@changesets/cli': major
'@changesets/read': minor
---

A very helpful description of the changes
```

---

The information below is for contributing to the bot.


## Setup

```sh
yarn
```

## Behaviour

The changeset bot will listen for pull requests being opened and pull requests that have been updated, upon which it will
then scan through the files for a changeset that has been added. The bot will make a comment on the PR stating
whether it found a changeset or not, as well as the message of the latest commit. If the PR is being updated
then the bot will update the existing comment
