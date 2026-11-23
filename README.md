# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arullimit94/mend.arul/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arullimit94/mend.arul/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits — finds the lines each edit names, and writes every change or none.

## Usage

```sh
node main.ts [options] [PATCH]
```

Run it with the working directory as the root of a tree of text files. With no `PATCH` argument it reads the patch from standard input. `main.ts` uses only the Node 22 standard library.

## Practice score

100 of 100 practice checks passed (practice score 1000), verified with the kit's `check.ts`.
