# Testing

## Everyday workflow

Run `pnpm install --frozen-lockfile` after a lockfile change, then `pnpm test` while developing. It runs
domain rules, API Worker tests and two small offline CLI/publication/SQL-restore
smoke tests. For ingestion changes, also run the affected file:

```sh
pnpm run test:ingestion apps/ingestion/test/evidence-cleanup.spec.ts
pnpm run test:api apps/api/test/health.spec.ts
pnpm run test:domain source-host-pacing-mode
```

Before review, run `pnpm run check` and `pnpm run test:full`, or use the full
ready-PR CI result. A quick pass is iteration feedback; full CI is the merge and
release standard. No production credentials or live publisher access are needed.

## Strategy: test transitions, then wiring

Test maintenance is a design cost. Correctness should depend on explicit inputs,
ordering and durable outcomes. A timeout detects a hang; it should not assert a
hosted machine's CPU or disk speed. The [September reassessment](testing-reassessment.md)
records the failures, decisions and validation behind this strategy.

Choose the narrowest boundary that proves the behavior:

| Boundary           | Exercise for real                                                    | Control or omit                                         |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------- |
| Domain             | Parsers, identity and business rules                                 | Worker startup, storage and scheduling                  |
| Storage transition | D1/R2, transactions, fences and owner intent                         | Scheduling through the existing direct Workflow drivers |
| Platform binding   | Dispatch, events, contention, termination or recovery of an instance | Unrelated setup and large datasets                      |
| Acceptance         | Selected HTTP/CLI journeys, process wiring and export/restore        | Offline publisher fixtures and bounded data             |
| Capacity           | Volume, throughput and resource measurements                         | Select explicitly through stress or benchmark commands  |

For ordinary rule and storage tests, prepare a verified starting state in a
scoped `beforeEach` and exercise one transition in the body. Every test owns fresh
state; do not make cases depend on earlier tests' writes. Setup retains its own
bounded hook deadline. A hook timeout still fails CI and needs diagnosis.

Multi-stage tests are appropriate when interaction between those stages is the
regression: for example, historical recovery or competing publication writers.
Do not chain independent cases under one deadline. Splitting them can add total
setup work; the purpose is isolation and shorter individual test bodies.

Keep dedicated binding tests in routine CI. Controlled execution does not prove
the platform scheduler. Conversely, repeating every rule through asynchronous
HTTP polling adds cost without a new wiring assertion. Retain real D1/R2 and
production functions instead of building a second application in mocks.

Use the smallest input crossing the actual boundary: two pages for pagination,
one record beyond a batch, two competing writers, or a streamed payload beyond
one chunk. The native image assertion runs with two distinct 100 KiB images in
routine coverage and 128 images in stress coverage. Both verify streaming,
publication, serving bytes and export references. The missing-capture regression
uses nine requests to cross an eight-request batch.

## Fixture contracts

Collection, preparation, publication and backup are separate contracts:

| Needed state                                   | Helper                                            | Guarantee                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Retained evidence                              | `collect`, `collectFixtureEvidence`               | Real capture/parsing and D1/R2; no implicit native preparation                                                        |
| Candidate rules/persistence                    | `prepareNativeCandidate`, `prepareNativeEvidence` | Explicit run, game, predecessor and returned candidate ID; controlled preparation reaches the expected terminal state |
| Published predecessor for preparation only     | `seedNativePredecessor`                           | Real owner approval, artifacts and published storage; backup is queued and **pending**                                |
| Complete publication or multi-revision history | `approveNativeCandidate`                          | Controlled production publication plus real SQL export/import and verified backup                                     |
| Actual scheduling or interruption              | Explicit `ThroughBinding` helpers                 | Platform instances with normal disposal                                                                               |
| Automatic native dispatch                      | `waitForDispatchedNativeCandidates`               | Parent `game_preparations` receipt followed by those exact candidate IDs                                              |

`seedNativePredecessor` is only for a next transition that stops at preparation.
Its typed result says `checkpoint: "pending"`; it never fabricates verification.
Do not use it for publication histories, backup health, restore, release preflight
or retention, and do not resume its deferred backup through a real binding. The
next publication must remain blocked by the real backup gate.

A completed collection does not imply native dispatch. Synthetic single-game
adapters can deliberately take a legacy aggregate path. Semantic fixtures request
native preparation explicitly. Waiters must neither create missing candidates
nor infer their identity by counting candidates attached to a collection.

The controlled owner driver rejects unrelated background dispatch. Dedicated
caller-retirement tests compare controlled and binding publication/checkpoint
behavior, verify zero preparation dispatch, candidate identity and pending-backup
fences. Preserve them when changing shared fixture contracts. Audit callers and
run a small hosted selection before full CI for a shared helper change.

## Commands

`pnpm run check` runs all non-test validation, including build dry runs. The
[command reference](commands.md) also covers development, formatting, generated
files and the renamed commands.

| Command                                        | Coverage / use                                                  |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `pnpm test`                                    | Everyday domain, API and two acceptance smoke paths             |
| `pnpm run test:full`                           | All routine domain, API, ingestion and acceptance               |
| `pnpm run test:domain`                         | Runtime-free rules and contracts                                |
| `pnpm run test:api`                            | API routes, authentication, reads and bindings                  |
| `pnpm run test:ingestion`                      | D1/R2/Workflow transitions, concurrency and recovery            |
| `pnpm run test:acceptance`                     | Routine HTTP/CLI, migrations, provider failures and SQL restore |
| `pnpm run test:acceptance:smoke`               | Small CLI and publication/restore paths                         |
| `pnpm run test:acceptance:extended <scenario>` | Explicit long recovery or retained-data journey                 |
| `pnpm run test:benchmark <scenario>`           | Explicit capacity/profiling experiment                          |
| `pnpm run test:stress`                         | Two bounded production-pacing checks used weekly                |
| `pnpm run test:stress:full`                    | All ingestion capacity experiments, explicit opt-in             |

Vitest accepts file filters and `-t 'test name'`. Acceptance commands accept
`--list` and `--shard=1/3`. Extended/benchmark commands require a scenario
or `--all`; listing never boots services. Selection lives in
`acceptance/helpers/test-tiers.mjs`, with a contract test proving that routine
files appear exactly once across three shards. New acceptance files enter routine
coverage by default. See [acceptance details](../acceptance/README.md).

“Full” means routine regression coverage. Extended, benchmark and stress cases
are deliberately separate. Weekly source recapture checks publisher freshness.

## CI and resource policy

| Event                                                    | Checks                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Draft PR opened, updated, reopened or converted to draft | Lint/format, types, generated files, boundaries/cycles, build dry run, domain, API and smoke |
| Ready PR opened, updated, reopened or marked ready       | Full checks, even if marking ready adds no commit                                            |
| Push to `main` or manual `ci` dispatch                   | Full checks on the resulting or selected commit                                              |
| Weekly/default manual `stress`                           | Two bounded pacing tests; five-minute job cap                                                |
| Manual `stress` with `suite: full`                       | All capacity tests; 45-minute cap; no merge/release gate                                     |
| Manual focused diagnostics                               | Selected files; diagnostic evidence only                                                     |

[ci.yml](../.github/workflows/ci.yml) retains three ingestion and three acceptance
shards. Each has an independent runner and at most two concurrent files. Local
layers run sequentially; domain, API, ingestion and routine acceptance use at
most two files, while stress/extended run one. These are concurrency limits,
not hard RAM quotas. Use `--maxWorkers=1` to investigate contention.

Main protection requires PRs, an up-to-date branch, `lint`, `checks`,
`domain-tests`, all three ingestion and all three acceptance shards. The
production release guard separately requires every job to succeed on the exact
main commit being deployed. Changing job IDs or shard counts requires updating
protection, that guard and its contract test together. Diagnostic workflows
cannot satisfy the release gate. Superseded CI runs are cancelled within an event
type; manual runs cannot cancel push-main evidence.

Quick checks should stay around one minute on a warm developer machine. CI caps
are five minutes for lint/domain and twelve for checks and each large shard,
including installation. Caps catch stuck runs; they are neither targets nor
performance guarantees. Recent hosted samples and their limits are in the
reassessment, rather than treated as promises of zero flakes.

Worker setup hooks and ordinary ingestion tests have 30-second defaults; API
bodies use the five-second Vitest default. Routine acceptance uses two minutes.
Some existing multi-stage/volume tests have explicit bounds; do not extend them
to mask failures. Reduce unrelated work or move a volume case after retaining a
bounded behavioral proof. Fixture setup and teardown must remain bounded too.

Ingestion, acceptance and draft smoke use a disposable 512 MiB tmpfs per hosted
runner for temporary databases. It allocates space as files grow and is removed
when the test step exits. Real storage isolation, transactions and SQL restore
remain enabled. Local storage settings are unchanged.

Routine tests use small offline fixtures and disposable state. They must not
require full catalogue replay or multi-gigabyte disk preflights. Full Riftbound
capacity remains opt-in with its 6 GiB preflight. Always clean up servers,
Workflows and temporary state after failures. Dispose Workflow introspectors
before resetting storage; the existing helper reactivates idle R2 buckets before
reset. Cloudflare documents [per-file isolation and explicit disposal](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/).

## Maintaining and diagnosing tests

- Assert observable behavior. Avoid import paths, helper names, source text or
  documentation wording as proxies. Keep structural tests for actual structural
  contracts such as migration constraints and the production release gate.
- Add one regression at the responsible boundary. Repeat it elsewhere only to
  prove a different contract. Reuse existing fixtures and drivers; a failing
  test does not by itself justify another helper mode or an overlapping test.
- Control ordering with promises/barriers, not sleeps or hopes about
  `Promise.all`. Distinguish an admission response from the eventual durable
  outcome, and settle late work before checking it.
- Derive retention times from recorded timestamps or an injected clock. Never
  rely on a fixed future date. Poll real asynchronous work with bounded deadlines;
  controlled fixtures should complete explicitly rather than wait for scheduling.
- Keep independent case identities distinct and reset storage between tests.
  Helpers should read only required identities/manifests; inspect all partitions
  only when their records are the assertion.
- Run the affected file first. For CI-only failures, use a focused hosted
  selection, fix the cause, then repeat that selection before full validation.
  Do not chase green with repeated full runs, larger timeouts, rate-limit changes
  or automatic retries.

Ingestion CI retains `ingestion-results-N` JSON artifacts for seven days with
test names, failures and durations. Successful tests suppress operational output;
failed tests retain it. Quieter reporting improves diagnosis, not timing.

The separate [focused workflow](../.github/workflows/test-suite-diagnostics.yml)
accepts exact Worker files and one or three independent runs. Any failed run
fails the job. Use it without creating another temporary workflow:

```sh
gh workflow run test-suite-diagnostics.yml --ref <branch> \
  -f worker=ingestion \
  -f files='apps/ingestion/test/source-refresh-publication.spec.ts apps/ingestion/test/native-printing-images.spec.ts' \
  -f repeats=3
```

Keep Vitest within the installed Cloudflare plugin's peer range (currently
Vitest 4.1; Vitest 5 fails before Worker tests execute). Commit manifest and
lockfile together and validate a small Worker file after upgrades. The CI
pnpm store cache includes OS, architecture, exact Node and pnpm versions,
manifest, lockfile, pnpm settings and the Corepack setup script. Every job runs
`pnpm install --frozen-lockfile`, including cache hits, to recreate links and
run approved native builds. Test and operational results are never cached.
Use the Node 26.8.2 version pinned in `.node-version` on Linux, and retain the existing three shards until
hosted measurements justify changing them. See [toolchain policy](toolchain.md).
