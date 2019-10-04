# changeset-bot

> A GitHub App built with [Probot](https://github.com/probot/probot) that Bot to detect changesets in PRs

## Setup

```sh
# Install dependencies
npm install

# Run the bot
npm start
```

## Installing in your repository

Install the bot from https://github.com/apps/changeset-bot and select the desired repository.

In your repository settings, add a new webhook with the following values.

- Payload URL - `https://smee.io/TNpTJ36TKInIWlgB`
- Content type - `application/json`
- Trigger events - `Pull requests`

## Behaviour

The changeset bot will listen for pull requests being opened and pull requests that have been updated, upon which it will 
then scan through the files for a changeset that has been added. The bot will make a comment on the PR stating 
whether it found a changeset or not, as well as the message of the latest commit. If the PR is being updated 
then the bot will update the existing comment.