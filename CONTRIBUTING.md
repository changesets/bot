# Contributing

## Setup

```sh
pnpm install
```

## Scripts

| Script              | Description                           |
| ------------------- | ------------------------------------- |
| `pnpm test`         | Run the test suite                    |
| `pnpm typecheck`    | Type-check the codebase               |
| `pnpm lint`         | Run all linters (JS + unused exports) |
| `pnpm lint:js:fix`  | Auto-fix lint issues                  |
| `pnpm format`       | Format source files                   |
| `pnpm format:check` | Check formatting without writing      |

## Behaviour

The changeset bot will listen for pull requests being opened and pull requests that have been updated,
upon which it will then scan through the files for a changeset that has been added.

The bot will make a comment on the PR stating whether it found a changeset or not, as well as the message of the latest commit.\
If the PR is being updated then the bot will update the existing comment
