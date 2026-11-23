# Fast Static Site Generator

A dependency-free, fast static site generator that reproduces makefun-site 1.0.0's build output byte for byte — front matter, templates, Markdown, slugs, collections, tags, and the build report — while running noticeably faster than the house baseline.

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/dmonziee/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/dmonziee/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

## How it works

`solve.js` exports `run(input)`, which builds the whole site for one case: it parses every source's front matter, renders the Markdown subset, resolves links, builds the post collection and tag index, renders each page through its layout template, writes the index and tag pages, copies the static files, and returns the full output tree plus `build-report.txt`.

`main.ts` is the harness driver: it reads the cases from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Run it

```sh
node main.ts
```

It reads `MAKEFUN_INPUT_DIR/cases.json` (or `/input/cases.json`) and writes `MAKEFUN_OUTPUT_DIR/answers.json` (or `/output/answers.json`).
