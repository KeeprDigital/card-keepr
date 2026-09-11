# Native publication caller retirement: final slice

Issue #274, part of #268. Fixed base: `e4d49f420e9cb3c0343ef54a9948720aadbdf146`
(PR #304, schema 32). The implementation, source inventory and validation here
supersede the remaining-work list from the September 9 ledger; its earlier
failed and intermediate runs remain historical evidence.

## Caller inventory

| Surface                                                                                                                                                                                                         | Disposition                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconciliation-scale.stress.spec.ts`: 1,001 Cards, 1,001 Products, 128 images, warning-heavy evidence                                                                                                          | All four now prepare actual game candidates and use native inspection, artifact preparation, whole-candidate approval, publication status and verified SQL backup/restore helpers. No aggregate reconciliation result authorizes publication. |
| Shared `reconciliation-helpers.ts:approve`                                                                                                                                                                      | Removed. Its last non-stress consumer now explicitly posts the retired request solely to assert HTTP 410 and no writes.                                                                                                                       |
| `reconciliation-export-and-repair.spec.ts`, `reconciliation-completeness-profiles.spec.ts`, `runtime-capacity-pause.spec.ts`, `runtime-collection-termination.spec.ts`, `publication-caller-retirement.spec.ts` | Intentional retirement/no-write or lifecycle rejection assertions remain.                                                                                                                                                                     |
| `lifecycle.spec.ts`, `reconciliation-workflow-binding.spec.ts`, `reconciliation-scale-and-recovery.spec.ts`, `historical-publication-fixture.ts`                                                                | Exact historical approval result/reservation observers, recovery, lease ownership, replay and reference-safe cleanup remain. Historical fixtures establish retained reservations explicitly; they are not current-data success callers.       |
| `acceptance/composed-recovery.test.mjs:approve`                                                                                                                                                                 | Local function uses native publication operations; its name is not a legacy endpoint call.                                                                                                                                                    |
| `combined-card-keepr-runtime.ts`, `retained-evidence-base-harness.ts`, `catalogue-publication-ingestion-harness.ts`                                                                                             | Historical response interceptors remain. They can observe an existing HTTP 200 historical recovery; they cannot turn an unreserved 410 into publication. Current native restore tests use the faithful SQL provider.                          |
| CLI `run approve`; `acceptance/ingestion-cli.test.mjs`                                                                                                                                                          | Local retirement error, exit 2, no request; negative CLI contract retained. Current success paths use `game-candidate`, `publication-preparation` and `publication` operations.                                                               |
| HTTP run approval; `observeHistoricalRunApproval` through ingestion facade/index                                                                                                                                | Only retained outcome/reservation observation and recovery. `approveRun` and `assertPublicationAggregateBudget` are absent. No new aggregate reservation or 16 MiB publication guard is restored.                                             |
| Operational scripts and maintained runbooks                                                                                                                                                                     | No operational script invokes fresh run approval. Bounded reconciliation and administration docs now point to the native protocol. Separate 16 MiB source-token, snapshot and subprocess limits are unrelated and retained.                   |

Inventory searched CLI, Workers, shared source, tests, acceptance and scripts for
`approve(`, `/approval`, `run approve`, `approveRun`,
`assertPublicationAggregateBudget` and the old numeric guard. Maintained docs
were checked separately. The historical inventory, prototypes and prior evidence
remain records of their own fixed bases, not instructions for new publication.

## Assertion translation

The large Card case replaces aggregate candidate JSON/chunk-layout assertions
with manifest-pinned native metadata pages (100 entries, 500 records/512 KiB
per partition), a bounded replay header, exact candidate identity and composition
membership, native search chunks and paginated consumer search. Its Card bytes
remain above 8 MiB and below 16 MiB, search retains its existing limits, all
1,001 IDs are exported, and the large `game_data` values compare losslessly.
The obsolete aggregate Workflow output envelope is not a native output contract.

Product assertions retain 1,001 Products, Releases and Distribution Contexts,
more than 8 MiB of exported Product data and verified R2 components. Export
manifests are read through every four-component page; current per-record objects
replace legacy revision-prefix component keys. Native gzip objects retain a
verified digest in their descriptor, not an R2 checksum field, so the physical
object assertion checks its bytes against that digest.

Images retain 128 × 100 KiB (13,107,200 bytes) with less than 1 MiB of candidate
metadata, no embedded base64, exact immutable serving bytes/digests and matching
export IDs. Warning partitions remain larger than 512 KiB in total, bounded
individually, with a small status document; a 9,000-character source field name
is retained without truncation. Every successful approval helper checks
`whole_candidate`, actual `published` status and the exact verified backup.

The maintained contract records canonical native request definitions, actual
CLI spellings, pending acknowledgements versus status, exact replay, distinct
candidate/operation generations, deadlines and stable errors. Root schema
records remain explicitly historical. Native CLI success currently exits 0
for acknowledgement/status; callers inspect state and backup outcome. No CLI
exit behavior or production mutation behavior changes in this slice.

## Initial local evidence and independent gap

Node 26.8.2, pnpm 12.3.4, Vitest 4.1.11 on macOS. These are local wall times,
not Worker CPU, provider billing, accepted-tier measurements or hosted CI.
Complete initial logs are retained under
[evidence](evidence/publication-caller-retirement-20260911/).

- All four original cases independently reach HTTP 410 and fail their old HTTP
  200 approval assertion (warning 3.268s, images 7.397s, large pair 28.17s).
- Native warning: pass, 12.15s; native 128 images: pass, 26.67s; native 1,001
  Cards: pass, 101.33s. These keep the existing 30s, 60s and 180s deadlines.
- Native 1,001 Products: failed the unchanged 120s test deadline; natural test
  completion was 154.481s, process 157.21s. The trace reaches the native switch
  and backup dispatch, not a retired endpoint. Later backup/export assertions
  are not certified by this run.
- The Product trace records 11,964 artifact callbacks (80.826s summed callback
  wall time) and 4,270 public-export callbacks (27.715s). This is local callback
  entry timing, not a disjoint end-to-end breakdown or CPU measurement.
- Five request-schema checks fail first for missing definitions and then pass.
- Focused native approval/no-change/images/export/cleanup and historical
  retirement family: 44/44 in six files, process 61.80s. Workerd background
  cancellation and binary-body text warnings remain in the raw log.

The Product timeout is transferred to #253/#275, retaining its full assertions,
fixture size, existing deadlines and production guards. It is distinct from the
already tracked native candidate's 15,000ms performance assertion. The four-case
stress requirement is not fully green; do not close #274 or claim full stress,
accepted-tier capacity or Go-Live from routine validation.

The combined four-case run reproduces the same disposition: **3 passed / 1
failed**, process 307.98s. The Product case again exceeds its unchanged 120s
deadline (natural test completion 170.944s) after reaching native switch and
backup dispatch. This is a reproduced performance gap, not a transient 410 or a
successful completion of the unreached Product backup/export assertions.

Final non-test validation (`pnpm run check`) passes, including types, generated
files, import boundaries, formatting and both build dry runs. The five schema
tests also pass after the review refactor. The retained log manifest records
uncompressed hashes and byte counts for each raw log.

Fixed-base reviews are recorded below. Final routine results, exact implementation
and PR CI references, and resulting-main integration status are recorded in
[issue #274](https://github.com/KeeprDigital/card-keepr/issues/274) and
[parent #268](https://github.com/KeeprDigital/card-keepr/issues/268). Baseline CI
[34552632337](https://github.com/KeeprDigital/card-keepr/actions/runs/34552632337)
passes all nine jobs at `e4d49f4`; it does not validate this implementation.

## Standards

Independent review used `git diff --cached e4d49f420e9cb3c0343ef54a9948720aadbdf146`
for the staged implementation; the commit list since that base was empty before
commit. Unrelated planning edits were excluded. Sources included AGENTS.md,
CONTEXT.md, ADR 0015, testing/toolchain policy and test-query guidance.

No documented-standard violations. One optional duplicated required-field test
loop was consolidated into `expectCompleteRequest`; all five schema tests pass
afterward, and the Standards reviewer confirmed the finding resolved. Final:
**0 documented violations, 0 unresolved smell findings**.

## Spec

Independent review compared the same staged diff to #274's current acceptance.
**0 actionable findings**: native callers, exact whole-candidate approval,
bounded metadata/search/export, immutable images, schemas and historical
survivors match the requested scope. No guard increase or bucket/writer change.

Acceptance is not fully complete: Product backup/export assertions after the
reproduced deadline failure remain unverified. Full routine and exact remote CI
results are separate evidence; passing review does not certify those gates.
