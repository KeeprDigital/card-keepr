# Package command audit

The owner requested a critical review of every package command, with unnecessary
commands, supporting files and workflow steps removed. The comparison starts at
`d43eb087d9764d4592c5fb5dcf218c48f4ea9c41`.

A command earns its place by serving an actual developer/operator task, owning
repository-specific arguments or providing a distinct CI workload. A rarely used
investigation is still useful when it has an explicit purpose and stays opt-in.
Removing an alias alone does not simplify the system if it merely forces callers
to repeat long configuration arguments or requires a new custom dispatcher.

## Decisions for all 29 commands

| Command                    | Decision       | Concrete value or reason for removal                                                                                                                   |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dev`                      | Keep           | Starts and stops the two cooperating local Workers together.                                                                                           |
| `dev:api`                  | Keep           | Starts one Worker for focused route debugging, with its configured port and inspector.                                                                 |
| `dev:ingestion`            | Keep           | Starts administration independently while debugging ingestion, with a separate port and inspector.                                                     |
| `db:migrate:local`         | Keep           | Applies the real schema to local development storage; pins the local target and correct D1 binding.                                                    |
| `keepr`                    | Keep           | Stable entry point for the repository's authenticated operator CLI and runbooks.                                                                       |
| `test`                     | Keep           | Everyday domain/API checks plus two small CLI/publication/restore smoke paths.                                                                         |
| `test:full`                | Keep           | One sequential entry point for all routine regression layers before review.                                                                            |
| `test:domain`              | Keep           | Fast rules/contracts, independently filterable and used by CI.                                                                                         |
| `test:api`                 | Keep           | Independent API Worker checks and focused route-test feedback; used by CI.                                                                             |
| `test:ingestion`           | Keep           | Independent storage/Workflow checks, file filters and CI sharding.                                                                                     |
| `test:acceptance`          | Keep; improve  | Routine HTTP/CLI and migration coverage, with CI sharding; now supports one focused file.                                                              |
| `test:acceptance:smoke`    | Keep           | Distinct two-file workload used by `test` and draft CI.                                                                                                |
| `test:acceptance:extended` | Keep           | Explicit retained-data and long recovery investigations; requires a selected scenario or `--all`.                                                      |
| `test:benchmark`           | Keep           | Explicit SQL export, memory and reconciliation measurements; avoids putting these expensive workloads in routine tests.                                |
| `test:stress`              | Keep           | The bounded production-pacing workload used by scheduled/default stress CI.                                                                            |
| `test:stress:full`         | Keep           | Deliberate full-capacity selection used by the existing manual stress workflow; different budget from the weekly subset.                               |
| `check`                    | Keep; simplify | Runs all static/generated/build checks once, without migration probes or application tests.                                                            |
| `lint`                     | Keep           | Whole-tree ESLint correctness gate shared by developers and CI.                                                                                        |
| `format`                   | Keep; improve  | Repairs only changed files; preserves generated/retained exclusions and now includes unpushed main commits.                                            |
| `format:check`             | Keep; improve  | Non-writing equivalent used by `check` and CI, sharing the corrected comparison-base behavior.                                                         |
| `typecheck`                | Keep           | Native TS7 compiler checking across five projects, beyond lint's rule-specific analysis.                                                               |
| `check:generated`          | Keep           | Detects stale Worker declarations and compiled schema validators; both are checked into the repository.                                                |
| `check:imports`            | Keep           | Enforces catalogue dependency directions, public cluster entry points and cycles; ESLint import resolution does not enforce these architectural rules. |
| `generate:worker-types`    | Keep           | Repairs declarations after binding/configuration changes, sharing the generator with its check mode.                                                   |
| `generate:validators`      | Keep           | Repairs compiled validators and signatures after schema changes; an independent artifact family.                                                       |
| `build`                    | Keep           | Validates both deployable Worker bundles and binding configuration without deployment; used by `check` and CI.                                         |
| `build:api`                | Keep           | Focused bundle validation for API-only changes; also composes `build`.                                                                                 |
| `build:ingestion`          | Keep           | Focused ingestion bundle validation; also composes `build`.                                                                                            |
| `check:lint-tooling`       | Remove         | Migration-specific diagnostic replay is unnecessary in every normal check and CI run.                                                                  |

## Removed and retained implementation

- Remove `check:lint-tooling` from the manifest, `check` and CI's lint job.
- Delete `scripts/lint-contract.mjs`, its nine active probe fixtures and their
  configuration-only globs/ignores. The original evaluation artifacts and Git
  history retain the migration evidence; no optional replacement command is added.
- Move the useful formatter regression out of `scripts/format-contract.mjs`
  into the ordinary Node acceptance suite. It checks our Git-selection logic,
  formatting write/check behavior, filenames with spaces and exclusions.
- Keep the four supplemental ESLint projects: they own real maintained Worker,
  Node and adjacent-declaration implementations, not just migration fixtures.
- Keep generation and catalogue-import helpers: they implement active checks
  that neither formatting nor ESLint replaces.
- Keep investigation runners, scenarios and stress workflows. They exercise
  distinct workloads and impose no cost on ordinary checks.

The result is 28 package commands. No plugin dependency or application behavior
is removed. CI job identities, shard counts, workload tiers and production
release requirements remain the same.

## Corrected command behavior

Formatting uses the locally available `origin/main` as its default comparison
base, falling back to `main` in repositories without that ref. Explicit
`--since=REF` still wins. This fixes the demonstrated case where a local main
commit was silently skipped because `main` already pointed at `HEAD`. It does
not fetch or rewrite unrelated baseline files.

Routine and smoke acceptance commands accept one exact scenario/filename,
including an `acceptance/` prefix. Selection is still restricted to the chosen
tier, so a routine command cannot start an extended journey or benchmark.

## Validation and review

- The complete `pnpm run check` passes in an isolated checkout of this diff,
  after a frozen install. The owner's unrelated untracked research files are
  absent from that validation copy. All literal nested script, source-file and
  workflow command references resolve.
- Both formatter tests pass. The unpushed-main test failed with the previous
  default because the command incorrectly reported no changed files.
- All five acceptance selection tests pass. Focused routine selection failed
  with the previous parser, and `pnpm run test:acceptance http-fixture` now runs
  and passes both HTTP-fixture tests.
- `pnpm run test:full` passes all 1,539 routine tests: 298 domain, 95 API,
  788 ingestion and 358 acceptance. Acceptance reports zero failures,
  cancellations or skips, including the new focused-selection regression.
- Independent Standards review: zero documented breaches or heuristic findings.
  Independent Spec review: zero actionable findings; reviewers also examined
  the retention reasons for all commands.
