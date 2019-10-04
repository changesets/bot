# @changesets/bot

## 1.2.0

### Minor Changes

- Add a link to create a changeset from the comment
- Optimise network calls

## 1.1.5

### Patch Changes

- 6dbc7dc: Fix babel configs for building packages to produce working dists for node scripts.

## 1.1.4

### Patch Changes

- 88dd1b5: Refactored bot to combine endpoints and added unit tests

## 1.1.3

### Patch Changes

- 5e9ecdc: Fix spelling error
- 2ca59c0: Change deployment environment to staging

## 1.1.2

### Patch Changes

- a18dd18: Got feedback that our changeset messages could be a bit loud/scary. Here is some lighter, friendlier text

## 1.1.1

- [patch] fa74183:

  - Link messages out to information on changesets

- [patch] a1d1b56:

  - Display commit sha instead of commit message in bot comment

## 1.1.0

- [patch] f7a6395:

  - Handle case where committer field in webhook event is null

- [minor] 9bd107d:

  - Added new bot to detect changesets on PRs
