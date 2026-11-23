# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sontv01034/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sontv01034/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads all four to one written contract, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. Built for the [make.fun bounty of the same name](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When it is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Matching

An edit's old lines are found at the first of three tiers at which they occur at least once: exact lines, then lines equal once trailing spaces and tabs are removed, then lines equal once leading and trailing spaces and tabs are removed. Context lines are written back as the file's own matched lines, and at tier 2 the other new lines are re-indented to the file's indentation. A unified hunk takes the occurrence nearest its (drifted) line number; a SEARCH/REPLACE block fails as ambiguous when its old lines occur more than once; a V4A chunk works from a cursor that moves past each anchor and each chunk it applies.

## Output and exit codes

- Exit 0: one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`. No file is written.
- Exit 2: one line for a usage error, an unreadable patch file, an undetected format, or a parse error (`error: parse <N>`).

`SPEC.md` is the whole contract. `check.ts` runs the 100 public practice checks from the kit against `main.ts`:

```sh
node check.ts <path to the kit's program/generator/practice.json>
```

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner: reads the checks from the trial env and runs `main.ts` on each one.
- `check.ts` — the practice set on your own machine.
- `SPEC.md` — the specification.
- `LICENSE` — MIT.
