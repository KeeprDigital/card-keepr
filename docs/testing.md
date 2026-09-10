# Testing

## Everyday workflow

Run `npm ci` after a lockfile change, then `npm test` during everyday development.
It runs domain tests, API Worker tests, and two small acceptance smoke files:
the external evidence CLI and native publication/SQL restore of two Riftbound
records. This checks business rules and a real path through the application.
It does not claim to cover every ingestion failure or recovery branch.

Run the affected integration file while changing ingestion behaviour:

```sh
npm run test:workers:ingestion -- apps/ingestion/test/evidence-cleanup.spec.ts
npm run test:workers:api -- apps/api/test/health.spec.ts
npm run test:domain -- source-host-pacing-mode
```

Vitest commands accept file filters and `-t 'test name'`. Use `--maxWorkers=1`
when investigating contention or working on a memory-constrained machine.
Acceptance commands accept `-- --list` to show their files without starting
services, and `-- --shard=1/3` to run a bounded portion of the selected tier.

Before marking a PR ready, run `npm run test:full` when practical, or let the
ready-PR CI run provide the full result. Also run `npm run lint` and
`npm run typecheck` for the changes. A passing quick check is feedback for
iteration; the full CI checks are the merge/release standard.

## Commands and coverage

| Command | What it proves | When to use it |
| --- | --- | --- |
| `npm test` | Domain rules, API behaviour, small real CLI/publication/restore paths | Everyday default; also covered by draft CI |
| `npm run test:full` | All domain, API and ingestion tests plus routine acceptance | Before review/merge; equivalent coverage runs in parallel CI jobs |
| `npm run test:domain` | Parsers, identity, reconciliation, legality, export and document contracts without a Worker | Fast feedback on pure logic |
| `npm run test:workers:api` | API routes, authentication, reads and binding behaviour | API changes |
| `npm run test:workers:ingestion` | D1/R2/Workflow writes, transactions, concurrency, corruption and recovery | Ingestion changes; file filters recommended during iteration |
| `npm run test:acceptance` | Routine HTTP, CLI, migrations, provider failures and SQL restore | Boundary or wiring changes |
| `npm run test:acceptance:smoke` | The two small end-to-end paths used by `npm test` | Quick wiring check |
| `npm run test:acceptance:extended -- <scenario>` | Selected long recovery or retained-data journey | Explicit investigation of that path |
| `npm run test:benchmark -- <scenario>` | Selected capacity/profiling experiment | Explicit measurement investigation |
| `npm run test:stress` | Two bounded production-pacing checks | Weekly CI and targeted pacing investigation |
| `npm run test:stress:full` | All ingestion Worker capacity experiments | Explicit opt-in; manual stress workflow with `suite: full` |

The full command excludes extended, benchmark and stress tests intentionally. “Full” means
all routine regression coverage, not every capacity experiment. No production
credentials or live publisher access are needed by the quick or full suite.
The separate weekly source-recapture workflow checks publisher freshness.

Acceptance selection lives in `acceptance/helpers/test-tiers.mjs`. Local and CI
commands use the same runner, with a regression test ensuring all routine files
appear exactly once across the three shards. New acceptance files enter routine
coverage by default. See [acceptance details](../acceptance/README.md). To investigate just one extended
journey, run its file explicitly, for example:

```sh
npm run test:acceptance:extended -- riftbound-catalogue
```

That command intentionally runs the large journey and retains its disk-space
preflight; use the smoke command for ordinary publication/restore feedback.

## CI policy

| Event | Checks |
| --- | --- |
| Draft PR opened, updated, reopened, or converted to draft | Lint/format, types, generated types, catalogue boundaries/cycles, build dry run, domain, API, and acceptance smoke |
| Ready PR opened, updated, or reopened | All of the above, plus all ingestion and routine acceptance tests |
| PR marked ready for review | Full checks immediately, even without another commit |
| Push/merge to `main` | Full checks on the actual resulting main commit |
| Manual dispatch of `ci` | Full checks on the selected ref |
| Weekly/default manual `stress` workflow | Two bounded pacing tests with a five-minute job cap |
| Manual `stress` with `suite: full` | All capacity tests with a 45-minute job cap; not a merge/release gate |
| Extended catalogue/recovery investigation | Explicit local command; not automatic CI |

The workflow is [ci.yml](../.github/workflows/ci.yml). Superseded runs for a PR or
ref are cancelled within the same event type; manual runs cannot cancel push-main
runs. Ingestion and acceptance each use three independent shards;
each shard runs at most two test files concurrently. Each matrix job receives its
own hosted runner; shards do not share a CPU. Drafts skip those two large
jobs, while the same job IDs and shard names remain mandatory for ready PRs and
main. Smoke runs in the domain job only for drafts. Full acceptance includes smoke,
so ready PRs and main run it once.

Main's branch protection was enabled and verified on 10 September 2026. It requires: `lint`,
`checks`, `domain-tests`, all three ingestion shards and all three acceptance
shards from GitHub Actions, PRs and an up-to-date branch. Enforcement includes
administrators; zero additional approving reviewers are required for this
owner-operated repository. Force pushes and branch deletion are disabled. The separate production-release guard still
requires every job to succeed on the exact deployed main commit.

Changes to job IDs or matrix sizes must also update that gate and its contract
test. This cleanup preserves their existing names.

## Resource and duration policy

- Quick checks should finish within about one minute on a warm developer machine.
  Treat sustained growth beyond this as a regression to investigate.
- Full CI should normally finish in a few minutes after setup. Lint and the
  domain/smoke job have five-minute caps; checks and each integration/acceptance
  shard have twelve-minute caps, including installation. A cap catches a stuck
  run; it is not a target duration or a guarantee of current CI performance.
- Local layers run sequentially. Domain, API, ingestion and routine acceptance
  each allow at most two concurrent test files. Stress and extended acceptance
  run one file at a time. These are concurrency limits, not hard RAM quotas;
  Worker integration is still more expensive than domain tests.
- Ingestion, acceptance and draft smoke CI use a disposable tmpfs capped at
  512 MiB per runner for temporary Worker databases. This bounds its extra storage
  memory and avoids slow temporary database writes on hosted disks. Space is
  allocated as files grow, not reserved up front. It does not change local storage settings,
  storage isolation, transactions, or SQL export/restore assertions. The mount
  is removed when the test step exits; hosted machines are disposable.
- Routine acceptance tests time out after two minutes; ingestion tests and Worker
  setup hooks retain thirty-second deadlines. API tests retain the Vitest
  default five-second deadline. Do not increase timeouts to mask a hang.
- Routine tests use small fixtures and disposable local state. They must not
  require multi-gigabyte free-space preflights or full catalogue materialization.
  Clean up servers and temporary state even when assertions fail.
- The full Riftbound capacity journey remains opt-in and retains its 6 GiB
  preflight. Its historical run took about 21 minutes and sampled 3.94 GB of
  local logical occupancy. That resource cost is unsuitable for everyday checks;
  bounded publication/restore tests cover the normal correctness requirement.
  The smaller mixed-game recovery fixture has no capacity preflight.

Local measurements on 2026-09-09 (macOS arm64, Node 26.3.0, two workers,
dependencies installed):

| Scope | Duration |
| --- | --- |
| Quick default: 248 domain, 95 API and two acceptance smoke tests | 42 seconds |
| Routine acceptance before publisher requalification: 334 tests across 58 files | 3 minutes 39 seconds |
| Requalified publisher and mixed-game recovery files (five tests) | 75 seconds total, two files at once |
| Weekly pacing checks (two tests) | 45 seconds |
| Unsharded ingestion: 746 tests across 87 files | 10 minutes 19 seconds |

Ingestion is excluded from `npm test` and sharded in CI because of this cost.
The full local command remains slower than the quick default; sharding does not
remove its total work. Historical acceptance timings are linked from its README
and are not measurements of the current full suite.

Hosted measurements on 2026-09-10 (Ubuntu, Node 22, standard public-repository
runners):

- All three acceptance shards passed in 2m37s–3m49s, including setup.
- The bounded stress job passed in 1m13s, including a clean install.
- Ingestion's first shard fell from 8m25s on disk to 4m47s with capped tmpfs.
  Early full-run samples completed their ingestion shards in roughly five to
  seven minutes. Timing-sensitive fixtures found during those runs were reduced:
  the warning boundary uses 76 observations instead of 373, and the coverage-loss
  boundary publishes 26 records instead of 100.
- A focused comparison of the same two publication tests took 26s with one
  worker and 16s with two. This supports retaining two workers; it is a small
  sample, not a claim that every test benefits equally from concurrency.

The [initial hosted measurements](https://github.com/KeeprDigital/card-keepr/actions/runs/34416927409)
and [concurrency comparison](https://github.com/KeeprDigital/card-keepr/actions/runs/34417355093)
record those samples. The subsequent
[focused verification](https://github.com/KeeprDigital/card-keepr/actions/runs/34418972137)
passed three consecutive runs of the five affected Worker tests (61–63 seconds
per run) and the six affected acceptance tests (106–107 seconds per run). These
focused repeats diagnosed reliability; they are not permanent retry settings
or substitutes for the complete merge checks. GitHub documents each standard public Linux runner
as a separate VM with four CPUs and 16 GB RAM in its
[runner specification](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Tmpfs's size option limits storage allocation; see the
[Linux filesystem documentation](https://www.kernel.org/doc/html/latest/filesystems/tmpfs.html).

## Adding and maintaining tests

1. Put pure rules in `test/domain`; use a Worker only for actual binding, storage,
   transaction or Workflow behaviour. Use acceptance for process/HTTP/CLI wiring
   that lower layers cannot prove.
2. Assert observable outcomes. Avoid matching import paths, internal helper
   names, source-code text or documentation wording as a proxy for behaviour.
   Keep structural checks when the structure itself is a contract, such as the
   production release gate or a database migration constraint.
3. Use the smallest fixture that crosses the relevant boundary: two pages for
   pagination, one record beyond a chunk boundary, or two competing requests.
   Replaying a whole catalogue belongs in extended/stress coverage.
4. Keep routine tests offline and deterministic. Derive retention times from the
   actual recorded timestamp or use an injected clock; never depend on a fixed
   future date remaining sufficiently far away. Use deterministic polling with
   deadlines for asynchronous work, rather than generous fixed sleeps.
5. Add one regression at the responsible layer for a bug. Repeat a case across
   layers only when each test proves a different contract. Move a slow test out
   of routine coverage only after retaining a bounded test of the same behaviour.
6. Keep setup identities distinct between independent parameterized cases, and
   still dispose Workflows and reset storage between tests. Publication helpers
   should read only the candidate identities/manifests they need; reading every
   data partition belongs in assertions that inspect those records.
7. Run the affected file first, then the appropriate quick/full check. For a CI-only
   failure, reproduce it in a small hosted selection, fix the cause, and repeat
   that selection before returning to the full suite. Do not use repeated full
   runs, larger timeouts, higher rate limits, or automatic retries to chase green.

Keep Vitest in the installed Cloudflare plugin's peer dependency range. The
current `@cloudflare/vitest-plugin` supports Vitest 4.1; Vitest 5 fails before
Worker tests execute. Commit the manifest and lockfile together after upgrades,
and validate a small Worker file before running the full integration suite.


## CI maintenance

The installed-dependency cache includes OS, architecture, exact Node version,
manifest, lockfile and npm configuration. Cache misses run `npm ci`; dependency
changes therefore validate a clean install. Main CI populates the cache, so there
is no separate cache-warming workflow. Keep one Linux/Node 22 configuration and
three shards per large suite until successful hosted durations justify a change.

Extended and benchmark commands require an explicit scenario or `--all`.
`--list` is always safe and does not boot services. See the acceptance README for
scenario names and the capacity probe's required report destination.
