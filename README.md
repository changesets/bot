# changeset-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that Bot to detect [changesets](https://github.com/atlassian/changesets) in PRs

## Please see https://github.com/apps/changeset-bot for details

the content below is for contributing to the bot.

---

## Setup

```sh
yarn
```

## Behaviour

The changeset bot will listen for pull requests being opened and pull requests that have been updated, upon which it will
then scan through the files for a changeset that has been added. The bot will make a comment on the PR stating
whether it found a changeset or not, as well as the message of the latest commit. If the PR is being updated
then the bot will update the existing comment
