# Commands

Run commands from the repository root after `npm ci`. `npm run` lists the
available scripts. Start with these:

| Task | Command |
| --- | --- |
| Develop locally | `npm run dev` |
| Get quick test feedback | `npm test` |
| Validate code, generated files and builds | `npm run check` |
| Run all routine tests before review | `npm run test:full` |
| Fix formatting in changed files | `npm run format` |

`check` and `test:full` together cover local review validation. `check` contains
no tests. `test:full` already includes everything in `npm test`, so there is no
need to run both for the same change. Stress tests, extended journeys and
benchmarks are separate opt-in workloads. See [testing](testing.md) for coverage
and CI policy.

## Local development and operator CLI

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts both local Workers; stops both when interrupted or either exits |
| `npm run dev:api` | Starts only the API Worker on port 8787, debugger on 9229 |
| `npm run dev:ingestion` | Starts only the ingestion Worker on port 8788, debugger on 9230 |
| `npm run db:migrate:local` | Applies migrations to the local development database |
| `npm run keepr -- <command>` | Runs the operator CLI against its configured target; see [CLI setup and commands](../cli/README.md) |

## Tests

| Command | What it runs |
| --- | --- |
| `npm test` | Domain tests, API tests and two acceptance smoke paths |
| `npm run test:full` | Domain, API, ingestion and all routine acceptance tests, sequentially |
| `npm run test:domain` | Domain rules and contracts without starting Workers |
| `npm run test:api` | API Worker routes, authentication, reads and bindings |
| `npm run test:ingestion` | Ingestion Worker storage, Workflow transitions, concurrency and recovery |
| `npm run test:acceptance` | All routine HTTP/CLI, migration, provider-failure and SQL-restore tests |
| `npm run test:acceptance:smoke` | Two small evidence CLI and native publication/SQL-restore paths |
| `npm run test:acceptance:extended -- <scenario>` | One long recovery or retained-catalogue journey |
| `npm run test:benchmark -- <scenario>` | One capacity or profiling experiment |
| `npm run test:stress` | The two bounded production-pacing Worker checks used by weekly CI |
| `npm run test:stress:full` | All ingestion Worker capacity experiments |

Pass filters to the individual suite, rather than the combined test commands:

```sh
npm run test:ingestion -- apps/ingestion/test/evidence-cleanup.spec.ts
npm run test:api -- apps/api/test/health.spec.ts
npm run test:domain -- source-host-pacing-mode
npm run test:acceptance -- --shard=1/3
npm run test:acceptance:extended -- --list
npm run test:benchmark -- native-sqlite-export
```

Acceptance commands support `-- --list` and `-- --shard=1/3`; there is no separate
shard command. Extended and benchmark commands require a scenario or `--all`.
Listing starts no services. See [acceptance details](../acceptance/README.md)
for available scenarios and benchmark report settings.

## Validation, formatting and generation

| Command | What it does |
| --- | --- |
| `npm run check` | Runs lint, format check, typecheck, generated-file checks, import checks and builds, in that order; stops on the first failure |
| `npm run lint` | Checks maintained code with Biome; does not rewrite files |
| `npm run format` | Rewrites formatting in branch changes since `main`, staged/unstaged edits and new untracked files |
| `npm run format:check` | Checks the same formatting without rewriting; CI passes `-- --since=origin/<base>` |
| `npm run typecheck` | Checks TypeScript across both Workers and their tests, plus domain tests |
| `npm run check:generated` | Checks that Worker declarations and compiled document validators match their sources |
| `npm run check:imports` | Checks catalogue import cycles and module boundary rules |
| `npm run generate:worker-types` | Rewrites both Workers' generated declarations after binding/configuration changes |
| `npm run generate:validators` | Rewrites compiled document validators and declarations after schema changes |

`typecheck` checks code against its types; `check:generated` catches stale
generated files. After using a generation command, commit the resulting files
alongside their source changes.

Both formatting commands apply Biome's configured exclusions and accept
`-- --since=<ref>` to choose a different comparison base. They compare from the
common ancestor with that base and include local edits. A clean tree with no
branch changes succeeds without processing files.

## Builds

| Command | What it does |
| --- | --- |
| `npm run build` | Runs both Worker build dry runs, sequentially |
| `npm run build:api` | Bundles and validates the API Worker with Wrangler's `--dry-run` |
| `npm run build:ingestion` | Bundles and validates the ingestion Worker with Wrangler's `--dry-run` |

Build commands do not upload or deploy. Production deployment uses the guarded
operator CLI flow in the [Production Release runbook](runbooks/production-release.md).

## Previous command names

| Previous command | Use now |
| --- | --- |
| `test:workers:api`, `test:workers:ingestion` | `test:api`, `test:ingestion` |
| `test:workers` | Run `test:api` and `test:ingestion`, or use `test:full` for all routine layers |
| `test:acceptance:shard` | `test:acceptance -- --shard=1/3` |
| `test:acceptance:runtime` | `test:acceptance`; the separate “routine minus smoke” subset is retired |
| `types:check`, `documents:check` | `check:generated` |
| `types:generate` | `generate:worker-types` |
| `documents:generate` | `generate:validators` |
| `check:catalogue-cycles`, `check:catalogue-boundary` | `check:imports` |
| `deploy:dry-run`, `deploy:dry-run:api`, `deploy:dry-run:ingestion` | `build`, `build:api`, `build:ingestion` |

Historical prototype demos are invoked directly from their own READMEs:
[Game Profiles](../prototype/v1-game-profiles-source-adapters/README.md),
[implementation contracts](../prototype/formalize-implementation-contracts/README.md)
and [Curated Revisions](../prototype/curated-revision-administration/README.md).
Their four `prototype:*` shortcuts, including the duplicate lifecycle alias,
have been removed from the root command list.
