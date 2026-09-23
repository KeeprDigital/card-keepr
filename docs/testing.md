# Testing

## Everyday workflow

After a lockfile change, run `pnpm install --frozen-lockfile`. Use `pnpm test` for
fast feedback and the affected ingestion file for storage/Workflow changes.
Before code review, run `pnpm run check` and `pnpm run test:full`, or use successful
full ready-PR CI on the exact code. The quick suite is not the merge/release gate.
Documentation-only changes need formatting, link/schema checks and any tests that
consume changed documentation; they do not require the full runtime suites.

| Command                                        | Scope                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm test`                                    | Domain, API and two offline CLI/publication/SQL-restore smoke files |
| `pnpm run test:full`                           | All routine domain, API, ingestion and acceptance                   |
| `pnpm run test:domain [filter]`                | Runtime-free rules and contracts                                    |
| `pnpm run test:api [file]`                     | API routes and bindings                                             |
| `pnpm run test:ingestion [file]`               | D1/R2/Workflow transitions and recovery                             |
| `pnpm run test:acceptance [scenario]`          | Routine HTTP/CLI, migrations, providers and restore                 |
| `pnpm run test:acceptance:smoke`               | Small external CLI and native publication/restore                   |
| `pnpm run test:acceptance:extended <scenario>` | Explicit long retained-data/recovery journey                        |
| `pnpm run test:benchmark <scenario>`           | Explicit capacity/profiling experiment                              |
| `pnpm run test:stress`                         | Two bounded pacing/throughput checks                                |
| `pnpm run test:stress:full`                    | Full ingestion volume, recovery and resource selection              |

Vitest accepts file filters and `-t 'test name'`. Acceptance accepts exact filenames
or scenario names, `--list` and `--shard=1/3`. Selection stays within the requested
tier. Extended and benchmark commands require a scenario or explicit `--all`;
listing boots no services. `acceptance/helpers/test-tiers.mjs` owns membership;
new acceptance files enter routine coverage by default. Routine acceptance runs
at most two files concurrently and partitions exactly once across three CI shards.

## HTTP contract alignment

Required `check:generated` compares both complete OpenAPI documents and compiled
validators with executable registrations. The independent required-operation
inventory catches a route removed from both registration and output. Existing
Worker tests validate actual response bodies, status/media branches and declared
header values; utilities include HEAD/204/304 body absence and degraded readiness.
Streaming tests retain byte, range and digest checks without buffering in the
validator. Generated request tests retain rejection cases and explicit historical
responses retain their own schemas. Add cases at the responsible boundary when a
route or Game Profile changes, then regenerate in that same slice. Documentation
Worker/CLI and release-smoke tests are part of the ordinary full gate.

## Test transitions, then wiring

| Boundary           | Exercise for real                                      | Control or omit                            |
| ------------------ | ------------------------------------------------------ | ------------------------------------------ |
| Domain             | Parsing, identity and business rules                   | Storage and scheduling                     |
| Storage transition | D1/R2, transactions, fences and owner intent           | Scheduling through direct Workflow drivers |
| Platform binding   | Dispatch, events, contention, termination and recovery | Unrelated setup and large data             |
| Acceptance         | Selected HTTP/CLI and export/restore journeys          | Live publishers; use offline fixtures      |
| Capacity           | Volume, resource limits and measurements               | Select separately from routine correctness |

Use the smallest input crossing the behavior's boundary: two pages, one record
beyond a batch, two competing writers, or bytes beyond one stream chunk. Keep
real D1/R2 and production functions; a second application built in mocks proves
little. Retain dedicated binding tests because controlled execution cannot prove
the platform scheduler.

Prepare verified state in a scoped `beforeEach`, then exercise one transition.
Each test owns fresh state. Chain stages only when their interaction is the
regression, such as competing publications or recovery across history. Keep setup
and test-body deadlines bounded; reduce unrelated work instead of extending them
to hide failures. Timeouts detect hangs, not machine speed.

Control ordering with promises/barriers, not sleeps or hopes about concurrency.
Separate dispatch acknowledgement from durable completion, and settle late work
before teardown. Derive retention clocks from recorded values or an injected
clock. Dispose Workflow introspectors before resetting storage. Always release
servers, Workflows and temporary databases on success and failure.

Assert observable outcomes. Add one regression at the responsible boundary;
repeat it only for a different contract. Avoid tests of documentation wording,
helper names or source text; keep structural checks for actual schema and release
constraints. Query helpers own named fixed SQL; tests own values, execution,
assertions and transaction composition. Generated release SQL remains the tested
output. Do not add generic helpers that accept arbitrary fixture SQL.

## Fixture contracts

| Needed state                     | Helper                                            | Guarantee                                                        |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| Collected evidence               | `collect`, `collectFixtureEvidence`               | Real capture/parsing and storage; no implicit native preparation |
| Prepared candidate               | `prepareNativeCandidate`, `prepareNativeEvidence` | Explicit run, game, predecessor and returned candidate ID        |
| Predecessor only for preparation | `seedNativePredecessor`                           | Published storage with backup explicitly pending                 |
| Complete publication/history     | `approveNativeCandidate`                          | Production publication and actual SQL export/import verification |
| Scheduling/interruption          | Explicit `ThroughBinding` helpers                 | Real platform instances with normal disposal                     |
| Automatic native dispatch        | `waitForDispatchedNativeCandidates`               | Parent `game_preparations` receipt and those exact candidates    |

Use `seedNativePredecessor` only when the next transition stops at preparation.
It must not stand in for backup health, complete publication, retention, release
or restore, and its deferred backup must not resume through a real binding.
The next publication remains blocked by the actual pending checkpoint.

A completed collection does not imply native dispatch. Synthetic single-game
adapters can use a legacy aggregate path. Request native preparation explicitly
when needed; waiters must not create missing candidates or infer identity from
candidate counts. The controlled driver rejects unrelated background dispatch.
Preserve the caller-retirement file's controlled/binding equivalence, exact IDs
and backup fences when changing shared helpers. Validate a small hosted selection
before full CI for such a change.

Read only needed partitions, for example `nativeCandidateRecords(id, ["cards",
"printings"])`. Header-only setup should not hydrate records. Complete reads
still traverse and verify every selected manifest page.

## Publication large-workload acceptance

The native image journey uses two distinct 100 KiB images routinely and 128 in
stress; both verify publication, served bytes, export identity and actual SQL
restore. The separate 128-image inline-source case stops at preparation and
checks its sub-1 MiB candidate bound. Different source layouts have different
metadata overhead. The missing-capture case uses nine requests across a batch of eight.

The 1,001-Product publication journey retains integrity, consumer and real
backup/restore assertions with a five-minute body hang cap. Native preparation
retains 1,001 Products, the 100-call callback bound and a 120-second hang timeout;
elapsed time is diagnostic. Report successful storage work, not a minimum number
of implementation subdivisions. Earlier failures keep their original verdicts.

The ingestion provider mock snapshots the owning runtime's SQLite file, streams
SQL through production backup storage/upload and imports it into an independent
disposable database. It requires `/usr/bin/sqlite3` on supported macOS/Linux hosts
and the [pinned test-plugin patch](../patches/README.md). Keep the manifest,
lockfile and patch together. `publication-backup-transport` covers snapshot,
parser and import boundaries; `publication-caller-retirement` covers controlled
and real binding publication/checkpoint behavior.

## Extended journeys and benchmarks

`composed-recovery`, `one-piece-two-source` and `riftbound-catalogue` are explicit
extended journeys. `extended-scenarios.yml` runs all three once per release
candidate and records the `extended-scenarios` commit status on that SHA; see
[manual staging](runbooks/manual-staging.md#validation-and-retained-outcomes).
Routine mixed-game recovery already crosses current-plus-two
retention and performs actual SQL restore; it has no large-disk preflight.
Only the full Riftbound journey requires 6 GiB free space. Its retained source
inventory and incomplete image coverage are described with the
[fixtures](../acceptance/fixtures/real-sources/2026-09-08-riftbound/README.md).

The explicit `bounded-capacity-pilot` benchmark composes two named synthetic
scopes (17 Printings, 34 separately streamed 100 KiB images), refreshes the first,
and verifies stable consumer/export identities and bytes after actual SQL restore.
Its test-provider collection scheduling is controlled; native candidate,
publication and backup Workflows execute normally. Use an absolute output prefix:

```sh
KEEPR_ACCOUNTING_OUTPUT_PREFIX=/tmp/keepr-accounting pnpm run test:benchmark bounded-capacity-pilot
```

The `-pilot.json` report separates disjoint logical R2 object prefixes from local
filesystem occupancy, D1 table/index allocations and restore files. Those views
overlap and must not be added together. Host headroom and driver resource usage
are point-in-time observations; unavailable isolate CPU/peak, billed writes and
write amplification stay unmeasured. Full-tier scope censuses are plans, not
executed 5/50 GiB capacity. Run with exclusive host resources. This benchmark does
not qualify the expanded launch sources or complete #275.

Benchmarks include `native-sqlite-export` crossing 64 MiB and
`native-isolate-metrics` for heap calibration. The reconciliation memory diagnostic
is excluded even from `test:benchmark --all` and all configured CI:

```sh
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/keepr-capacity pnpm run profile:reconciliation
```

It requires a destination and writes `-summary.json`, `-workload.json` and
`-isolate-1.json`. Keep the variable scoped to this invocation; a global export
adds profiling overhead to other acceptance Workers. The source script documents
external-source and declared-length variants. Temporary state is removed after
reporting; failure may retain it with its location printed for inspection.

The former 64 MiB target is a historical comparison, not an enforced application
memory budget. Sampling gaps/errors remain `incomplete`; error-free observations
are `sampled`, never proof of complete peak memory. Exit zero requires a sealed
workload and valid nonempty samples, even if sampling is incomplete. Workload,
report or sample failures and the 120-second hang guard return an error.

## What the stress commands prove

Stress commands mix volume, recovery, configured-limit and performance checks.
A successful workload establishes its asserted behavior at that size, not maximum
production capacity. Tier admission without fetched bodies cannot prove 5/50 GiB
capture. Native elapsed time is diagnostic; collection's per-request overhead
requirement remains. Timing is neither active CPU nor provider billing.

Local runtimes enforce no Worker CPU or subrequest limit. Archive and barrier
structure checks therefore drive the production Workflow bodies with a recording
step and assert declared per-step budgets, lost-response retries without
duplicates and invocation yields. Routine files use a few thousand records and
a dozen polls; the 150,000-record archive and 600-poll barrier run only in
`test:stress:full`. Archive fixtures carry distinct per-record bytes so their
compressed form spans several read ranges: a fixture built by repeating a few
records compresses into one range whatever its record count, which leaves the
decoder's range boundaries untested at every volume (#327).

Run comparable heavy experiments sequentially with exclusive host resources.
Record the exact commit, runtime, complete selection and failed/incomplete results.
Resource-bound arguments do not replace measured heap/CPU or real-source coverage.
Use the [scheduled stress procedure](runbooks/scheduled-stress.md) for hosted runs.

## CI and resource policy

| Event                                        | Required coverage                                                 |
| -------------------------------------------- | ----------------------------------------------------------------- |
| Draft PR                                     | Static checks, build dry runs, domain, API and smoke              |
| Ready PR, including ready-without-new-commit | Full checks and routine suites                                    |
| PR or merge-queue run, allow-listed paths    | `lint` and `checks`; domain, ingestion and acceptance skip        |
| Push to `main` or manual CI                  | Full checks on that exact commit, whatever changed                |
| Weekly/default stress                        | Two bounded tests; five-minute job cap                            |
| Manual full stress                           | Full stress selection; 45-minute cap; separate from merge/release |
| Release created, `v*` tag or manual SHA      | Three extended journeys once per SHA; `extended-scenarios` status |
| Focused diagnostics                          | Selected files, one or three independent runs; any failure fails  |

The `changes` job classifies pull request and merge-queue diffs (#401). Heavy
jobs skip only when every changed path is on the allow-list in
`scripts/ci-change-scope.mjs`: Markdown outside test trees, issue templates,
`.artifacts/` and license/ownership files. Workflows, actions, manifests, the
lockfile, `docs/examples/` and documents that tests read run everything; a failed
classification also runs everything. Skipped ingestion and acceptance shards
run a no-op step so each required `name (N)` check still reports. When a test
starts reading a document, add it to the classifier's consumed documents;
`acceptance/ci-change-scope.test.mjs` fails until then.

Production Release requires the complete successful CI check set on its selected
commit contained in `main`. Local tests, a green PR head or a newer commit cannot
substitute for that evidence. Ordinary tests require no production credentials or
live publisher access. Weekly source recapture is a separate networked workflow.

Worker setup hooks and ingestion bodies default to 30 seconds; API bodies to five
seconds; routine acceptance to two minutes. Explicit scenario bounds live with
the tests. Each ingestion file's isolated runtime must stop within one minute or
the file fails; the 20-minute ingestion job cap is the outer backstop, not a
hang detector. Hosted ingestion, acceptance, smoke and bounded stress use disposable
512 MiB tmpfs; full stress and memory-based stress diagnostics use 2 GiB. Local
storage is unchanged. `scripts/ci-test.sh` owns allocation, occupancy reporting
and cleanup. Routine ingestion balances its four shards using source-derived
native fixture/setup call sites, with checkout-relative paths breaking ties.
Every selected file has a base weight, including newly added files without known
fixtures. This estimate does not expand loops or parameter tables, follow aliases,
or distinguish matching text in comments/strings. The [partitioner](../test/support/ingestion-shards.ts)
owns the exact heuristic; measured timings stay in diagnostic artifacts. Default
within-shard sorting, unsharded runs and stress selection remain unchanged.
Three ingestion shards measured 7-12 minutes against a 12-minute cap (#374);
retain four until measurements justify another change. Acceptance keeps three.
Test/operational results are never cached.

The in-process acceptance runtime also appends the worker's own output to
`worker-live.log` beside its state directory as it arrives. `getOutput()` still
returns the buffer, but a run that hangs never reaches teardown and would
otherwise report nothing at all; the live file survives a killed job (#445).

The ingestion runtime runs workerd without `--verbose`. With it, every Workflow
dispatch logged `uncaught exception ... Engine was never started` and
`instance.not_found`: miniflare's Workflows binding rejects `get()` for an
instance that does not exist, and the workflow driver probes existence before
every create. Those lines are expected, not failures; test results and Workflow
statuses do not depend on workerd's stderr.

For CI-only failures, select the failing file first, fix the cause, then rerun it
before full validation. Do not chase green with repeated full runs, automatic
retries, larger deadlines or changed rate limits. Ingestion CI retains seven-day
JSON results with names, failures and durations; successful operational logs are
suppressed, failed ones retained.

```sh
gh workflow run test-suite-diagnostics.yml --ref <branch> \
  -f worker=ingestion \
  -f files='apps/ingestion/test/publication-caller-retirement.spec.ts' \
  -f repeats=1
```

Keep Vitest within the installed Cloudflare plugin's peer range. Validate an
affected Worker after upgrades before broader suites; the separate acceptance
and plugin runtimes must both remain compatible.
