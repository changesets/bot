# changeset-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) to detect [changesets](https://github.com/atlassian/changesets) in PRs

## Install the bot at https://github.com/apps/changeset-bot



This bot will comment on PRs saying that either a user might need to add a changeset(note that PRs changing things like documentation generally don't need a changeset)or say that the PR is good and already has a changeset.

<img width="1552" alt="screenshot of changeset bot message from https://github.com/mitchellhamilton/manypkg/pull/18 before a changeset was added" src="https://user-images.githubusercontent.com/11481355/66183943-dc418680-e6bd-11e9-998d-e43f90a974bd.png">

<img width="1552" alt="screenshot of the changeset bot message from https://github.com/mitchellhamilton/manypkg/pull/18 showing the changeset good to go message" src="https://user-images.githubusercontent.com/11481355/66184229-cf716280-e6be-11e9-950e-0f64a31dbf15.png">


Sometimes, a contributor won't add a changeset to a PR but you might want to merge in the PR without having to wait on them to add it. To address this, this bot adds a link with the filename pre-filled to add a changeset so all you have to do is write the changeset and click commit.

<img width="1552" alt="screenshot of the changeset bot message from https://github.com/mitchellhamilton/manypkg/pull/18 focused on the create a changeset link" src="https://user-images.githubusercontent.com/11481355/66184052-3a6e6980-e6be-11e9-8e62-8fd9d49af587.png">

<img width="1552" alt="screenshot of creating a changeset directly on GitHub" src="https://user-images.githubusercontent.com/11481355/66184086-5bcf5580-e6be-11e9-8227-c1ed6d96b5d2.png">

<img width="1552" alt="screenshot of the GitHub file creation page focusing on the commit button" src="https://user-images.githubusercontent.com/11481355/66184181-a94bc280-e6be-11e9-85fc-32edcd5b05ce.png">

<img width="1552" alt="screenshot of the changeset bot message from https://github.com/mitchellhamilton/manypkg/pull/18 showing the changeset good to go message" src="https://user-images.githubusercontent.com/11481355/66184229-cf716280-e6be-11e9-950e-0f64a31dbf15.png">

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
