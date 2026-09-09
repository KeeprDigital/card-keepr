# Private launch reliability baseline — 9 September 2026

## Preserved before the toolchain change

Baseline main: `51e1c83f64fb69abe82b190dc15918637c94f8dd`.
Reviewed cleanup base: `a14a803434dcc7bb150802dad3476989d0f61355`;
its application change is `d6761a9c`.
See [the original complete test ledger](project-cleanup-2026-09-09.md).

The original logs were copied before #272 modified its separate worktree.
The local preserved directory is
`/tmp/card-keepr-launch-20260909/baseline-before-toolchain`.
The table below pins the local diagnostic artifacts; it does not make these
files portable CI or release evidence. Current-main CI's failed log is retained
alongside the cleanup logs. Missing or interrupted tests remain incomplete.

Old local runtime: macOS arm64, Node 26.3.0, Vitest 4.1.10,
Workers test pool 0.18.8, Wrangler 4.114.0, Miniflare 4.20260722.0,
workerd 1.20260722.1. CI uses Ubuntu and Node 22.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `card-keepr-cleanup-full-20260909/acceptance.log` | 35508 | `412a02e811e59504ab85a687da2ffb6bdc1b1a223d545055af0aeaea9d94718e` |
| `card-keepr-cleanup-full-20260909/api.log` | 328 | `96b46186aa94abe9ea79d0bda73d92293f05e9f8cf5686ca14bda8847bd87d78` |
| `card-keepr-cleanup-full-20260909/domain.log` | 325 | `e6ae4d224b60f43958f913ba4dd21b3d2807d46c0b5354c70ee47621186c6a66` |
| `card-keepr-cleanup-full-20260909/ingestion.log` | 2644576 | `50e7690bab780545a5822d5043bf2597716930e0f5a08d30e3d3452817a1d10b` |
| `card-keepr-cleanup-full-20260909/riftbound-bounded-stop.json` | 471 | `d5329878f09232755d9d0524ceb9384e513bb39b623c32bad395e307d0e74160` |
| `card-keepr-cleanup-full-20260909/summary.json` | 4100 | `b9790778bac1acf078bb5d65809e484aefaaa07fb15a8ab8a131e986fe216e61` |
| `card-keepr-cleanup-static-20260909/deploy-dry-run.log` | 4415 | `9cb74596cf8634a008d72f6a62fa060c00457998f476304414ad3eec86eb12a7` |
| `card-keepr-cleanup-static-20260909/documents-check.log` | 67 | `6ed50b3c732cecb99b75d53138e106972684f320aa3406019aa3302fdfd4e86b` |
| `card-keepr-cleanup-static-20260909/summary.json` | 178 | `e1a857240672a51c61e1dabe6d4f3885dc6590ecdaa949dbfbc8fa2d9d1c773a` |
| `card-keepr-cleanup-static-20260909/types-check.log` | 610 | `87779353e5a178befe8e34a0074449c89b378b84a7d4da44d5d0830dcbc5816a` |
| `card-keepr-cleanup-stress-entrypoint.log` | 48648 | `8a33f038b08c62066ab5a8ec75d31663c4c2178837d849dc158cc03dcd2e74ba` |
| `cleanup-ci-ingestion1.log` | 24671251 | `935dc9a24e7ec12487bb1f3681bb65e124a883e2a24c3cda4130d073c5567d18` |
| `cleanup-ci-ingestion2.log` | 26529672 | `467722e3080cad29a9eb01a28255e1d9d50fde5cad9bc069d4fdba1e4f4a6cbb` |
| `cleanup-ci-ingestion3.log` | 30707482 | `f706421c553aa460a535e15a55e25ee809b5a175abb1e220ef5cc2be6f98ab15` |
| `main-ci-failed.log` | 60574752 | `aad85346f60bc9b1aaeb075b4db926f29561dd913c8789777a61cb425d05ee5f` |
| `pacing-diagnostics.log` | 50766 | `5da81da59e0e39648a4634fd35e105997fdd1f48d0a550765cbbb7720b82e676` |
| `pacing-repro.log` | 49062 | `1af44054c71c0960c6f3945eab448b6977f31b56984ba6051b84aa06ed52a4d0` |

## Stress diagnosis (#253)

The original host-pacing test reproduces on the old runtime: one failure in
4.08 seconds, reporting `NaN >= 500` at its timestamp subtraction.
A diagnostic probe confirmed that all four fetch attempts have valid timestamps.
The fixture plan now gives requests canonical discovery/listing identities,
so the test's `first-a`/`second-a` labels no longer identify retained attempts.

The test now resolves each attempt from the retained Source Snapshot URL and
fetch-attempt identity. It explicitly requires the snapshot, attempt and finite
timestamp, then retains the same per-host minimum spacing and cross-host
concurrency assertions. The corrected file passes in 3.66 seconds on the old
runtime, with typechecking passing. The probe was removed.

This focused fix does not complete #253: the full stress selection and a green
scheduled or manually dispatched workflow remain required after integration.
The wider #271 clock, collision, timeout and complete Riftbound results remain
open until their causes and final-runtime validation are established.

## Cleanup Actions context

[CI run 34329801911](https://github.com/KeeprDigital/card-keepr/actions/runs/34329801911)
on cleanup head `a14a803434dcc7bb150802dad3476989d0f61355` has 22
ingestion failures across three completed shards. PR checks use GitHub's
synthetic merge context, with Node 22 on Ubuntu; they are distinct from
macOS local results. Lint, domain and combined checks passed. Acceptance
shards 1 and 3 failed; shard 2 was still running at this observation.
The failure families below remain unresolved until diagnosed; no claim is
made that the entire local and hosted failure sets are equivalent.

### cleanup-ci-ingestion1.log

- `apps/ingestion/test/evidence-cleanup.spec.ts > owner reclaims a positively inventoried abandoned preparation orphan without traversing shared roots`
- `apps/ingestion/test/evidence-cleanup.spec.ts > a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations`
- `apps/ingestion/test/evidence-cleanup.spec.ts > an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence`
- `apps/ingestion/test/evidence-cleanup.spec.ts > an unrelated staging key progresses while a prior delete outcome remains unknown`
- `apps/ingestion/test/evidence-cleanup.spec.ts > concurrent conflicting staging starts cannot silently share an idempotency key`
- `apps/ingestion/test/reconciliation-card-identity.spec.ts > historical Gundam locators survive disappearance without retaining stale Card authority`
- `apps/ingestion/test/reconciliation-card-identity.spec.ts > Gundam substantive Printing fact conflicts outside the identity tuple block in both locale orders`
- `apps/ingestion/test/reconciliation-curated-lookup.spec.ts > a curated relationships lookup returns bounded progress across unrelated entities`
- `apps/ingestion/test/reconciliation-export-and-repair.spec.ts > publication rejects an over-budget candidate before writing any immutable object`

### cleanup-ci-ingestion2.log

- `apps/ingestion/test/game-reconciliation-operations.spec.ts > a native source change retains reconfirmable curated diagnostics without failing the collection`
- `apps/ingestion/test/identity-corrections.spec.ts > reviewed identity associations prepare through durable bounded groups`
- `apps/ingestion/test/identity-corrections.spec.ts > reviewed identity lookup prepare through durable bounded groups`
- `apps/ingestion/test/identity-corrections.spec.ts > reviewed identity application prepare through durable bounded groups`
- `apps/ingestion/test/publication-preparation.spec.ts > a fresh candidate reuses unchanged fact components while retaining a distinct bound root`
- `apps/ingestion/test/publication-preparation.spec.ts > a lost old start replay cannot pause newer work when its original dispatch fails`
- `apps/ingestion/test/reconciliation-workflow-binding.spec.ts > parsed observation count warnings use the normative absolute threshold`
- `apps/ingestion/test/source-refresh-publication.spec.ts > unexplained substantial coverage loss blocks completeness rather than becoming ordinary disappearance`

### cleanup-ci-ingestion3.log

- `apps/ingestion/test/reconciliation-prior-state-cursor.spec.ts > prior Cards from 'curated-conflict-fanout-base' resume through durable returning groups ('official_assembly')`
- `apps/ingestion/test/reconciliation-prior-state-cursor.spec.ts > prior Cards from 'curated-conflict-fanout-base' resume through durable returning groups ('disappearance_warnings')`
- `apps/ingestion/test/reconciliation-prior-state-cursor.spec.ts > prior Cards from 'prior-state-text-pages' resume through durable returning groups (undefined)`
- `apps/ingestion/test/reconciliation-progress.spec.ts > a published catalogue larger than 1 MiB is streamed into the next candidate without an aggregate prior-payload read`
- `apps/ingestion/test/reconciliation-progress.spec.ts > admission selection is frozen without an unbounded operation-start write`


## Staging cleanup clock regression

On the reconciled #272 runtime at provider commit
`0b4b41ddc6be9501a6e810e83c3e6955fba55741`, the single abandoned-orphan
cleanup test reproduced its 409-versus-202 failure in 2.18 seconds. A temporary
probe showed SQLite's immutable `terminal_at` was
`2026-09-09T09:02:58.845Z`, while the fixture requested cleanup at
`2026-10-09T00:00:00.000Z`: less than 30 days later. The API correctly returned
`evidence_cleanup_not_eligible`. The other four staging failures depended on
this same fixture, sometimes surfacing later as missing cleanup intents.

The fixture now reads the actual retained terminal instant and uses the
existing request-clock seam to select the exact 30-day eligibility boundary.
The orphan test also asserts rejection one millisecond before that boundary.
Production clock ownership and retention guards are unchanged. All 23 tests
in `evidence-cleanup.spec.ts` pass in 10.00 seconds, and typechecking passes.
The temporary probe has been removed. Logs are retained under
`/tmp/card-keepr-launch-20260909/cleanup-clock-{red,probe,green}.log` and
`cleanup-clock-typecheck.log` on the validation host.

## Suite concurrency investigation

The unmodified reconciled provider's complete local ingestion selection failed
17 of 753 tests across 88 files in 427.90 seconds (3,569.59 seconds summed test
time). Apart from the five clock failures above, failures included timeouts,
incomplete Workflow polling and an immutable evidence collision after earlier
tests had timed out. Hosted Node 22 results are tracked separately in the
#272 toolchain ledger; a matching test name does not establish a matching cause.

A controlled serial comparison retained normal per-file storage isolation and
all existing timeouts, changing only the Vitest worker count to one. The four
files `reconciliation-curated-lookup`, `publication-preparation`,
`identity-corrections` and `reconciliation-workflow-binding` passed all 49 tests
in 99.98 seconds (95.45 seconds summed test time). The log is
`/tmp/card-keepr-launch-20260909/reliability-serial-comparison.log`.
This supports investigating host contention and timeout cascades; it does not
establish that all suite failures are resolved. Operational error logs from
intentional fault paths and runtime teardown remain visible in the retained
log; the process exited normally with status zero.

The ingestion configuration now explicitly uses one Vitest worker, including
stress selections. Each file still receives isolated storage and retains its
existing deadlines. This bounds concurrent runtime processes per host; it does
not serialize the application concurrency exercised inside a test. Complete
local and hosted validation of this configuration remains pending. The
49-test comparison above exercised the same setting through the CLI.

## Independent review checkpoint

Two independent implementation peers reviewed the nonempty fixed-base diff from
`0b4b41ddc6be9501a6e810e83c3e6955fba55741` through
`0942e09658ab264fd750b01447f8132fffc4e508` (four code files and this ledger).
Standards reported zero hard violations and zero heuristic smells. Spec reported
no actionable code findings and confirmed the unchanged clock, identity,
isolation and timeout guards. Reviewers performed read-only analysis and no
runtime tests. Both axes explicitly retain complete current-runtime validation,
suite-context diagnosis and #253's green scheduled/manual run as unfinished
acceptance; this is a reviewed partial implementation checkpoint.
