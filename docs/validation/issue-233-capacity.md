# Issue 233 capacity and fault evidence

Campaign base: `0bb3b7d26c6744b4c037d788e6b45c334ae8aa83`, schema 28.
This is an initial acceptance/evidence matrix, not a passing capacity report.
Heavy campaigns run serially with a frozen commit and a fresh `/tmp` filesystem
preflight. Historical issue 232 failure states remain owned by the coordinator.

| Accepted requirement | Existing evidence at base | Campaign gap / action |
| --- | --- | --- |
| 128 × 100 KiB image pipeline | `reconciliation-scale.stress.spec.ts` collects 16 documents, checks 128 immutable references / 13,107,200 bytes, and approves | Run unchanged reproduction; report actual outcome and census |
| 10,000 Printings / 20,000 images / 5 GiB images / 100 MiB structured data | No matching executable tier found | Add explicit tier replay; distinguish admission/guard failure from successful completion; avoid materializing entire generated input |
| 100,000 Printings / 200,000 images / 50 GiB images / 1 GiB structured data | No matching executable tier found | Same; local disk is a separate campaign constraint, never an application capacity result |
| Complete declared P-001 | `issue-231-one-piece.md`: six publications and actual restored consumer/image verification at `a46aeb8`; 703 s | Run final P-001 command with expanded metrics; retain bounded source declaration and label disappearance/outage injection |
| Actual Riftbound | `riftbound-native.md`: full journey `445d4ce`, 1,222 s; five-game composition/restore `7292bc9`, 63.7 s | Run final actual-source command with expanded metrics; reuse independent five-game proof unless affected |
| CPU / working set / calls / D1 and index amplification / concurrent occupancy / owner actions / billed dimensions | P-001 driver CPU/RSS, statement preparations, batch submissions, table/index allocation | Instrument execution and occupancy; driver CPU/RSS cannot stand in for isolate metrics; unavailable billed/platform dimensions remain explicit gaps |
| Product-heavy duration | Legacy base failed 15 s polling; native base 15,198 ms and inspection head 16,350 ms; max 78 calls | Reproduce both unchanged deadlines with phase diagnostics before tuning; unresolved timing is failure |
| Durable collection interruption and lost writes | `runtime-storage-recovery.spec.ts`, `runtime-collection-batch-replay.spec.ts`, `runtime-workflow-recovery.spec.ts` | Audit exact boundaries and use existing cases; no duplicate harness for proven boundaries |
| Reconciliation interruption / commit replay | `reconciliation-progress.spec.ts`, `reconciliation-shards.spec.ts`, `reconciliation-workflow-binding.spec.ts` | Map retained stages, reservations and lost commit output against native flow |
| Preparation retry / corruption / stale writer | `publication-preparation.spec.ts`: partial upload exhaustion/resume, image/projection/composition corruption, stale sequence, abandoned owner, deadline, old dispatch | Reuse cases; add only uncovered durable boundaries |
| Approval replay / expiry / contention / atomic switch | `game-publication.spec.ts`, `game-publication-workflow.spec.ts`, `game-reconciliation-fences.spec.ts` | Audit expiry after approval/backup wait and unrelated-game contention; preserve exact approval/deadline |
| Backup failure / lost export or import response / recovery fence | `backup-recovery.spec.ts`, `composed-recovery.spec.ts`, `recovery.spec.ts`; native real journeys prove actual SQL export/import | Reuse injected faults; retain separate actual restore proof; never manufacture verified checkpoints |
| Cleanup race / retention / late writers | `evidence-cleanup.spec.ts`: exact 30 days, reference acquisition, ambiguous deletion, multipart abort, old ticket incarnation, paused/shared/historical evidence | Reuse full fault file and preserve current-plus-two/export/backup retention |

Existing evidence is historical provenance, not a new run result. The issue 232
identity immutable-key collision remains unexplained: 705/706 full ingestion,
then exact case and complete 11-test file passed unchanged. It is not a fix.

No dollar estimate, completion SLA, isolate headroom claim, deployment, resource
provisioning, live cleanup, release-gate waiver, merge, or issue closure is part
of this initial matrix.

## Campaign boundaries and initial observations

The unchanged stress command passed at `0e60268` (5 tests / 2 files, 72.38 s):

```sh
KEEPR_TEST_SUITE=stress npx vitest run --config apps/ingestion/vitest.config.ts \
  --maxWorkers=1 apps/ingestion/test/reconciliation-scale.stress.spec.ts \
  apps/ingestion/test/game-reconciliation-scale.stress.spec.ts
```

Log: `/tmp/issue-233-baseline-stress.log`. This includes the original 15-second
legacy Product reconciliation and native 1,001-Product assertions without changes,
plus 1,001 Cards, the reproduced 128 × 100 KiB images and warning partitions.
A pass on this host/base does not explain the historical failures, establish a
stable duration percentile, or justify changing a deadline. No budget was tuned.

Both exact synthetic shapes now have deterministic page generators, with 16
Printings and 32 digest-bound image bodies per page. The 100 MiB / 1 GiB structured
census excludes inline base64 transport values; retained source bodies therefore
occupy more than this structured census. Byte allocation across images/pages
sums exactly to the accepted totals. Tests verify first/last generated pages,
actual decoded bytes/digests, structured lengths and the adapter's per-page
contract. This is generator verification, not full-pipeline measurement.

| Planned tier | Source pages | Raw image bytes alone | Raw source encoding implication |
| --- | ---: | ---: | --- |
| 10,000 Printings / 20,000 images | 625 | 5,368,709,120 | About 6.67 GiB base64, plus 100 MiB metadata |
| 100,000 Printings / 200,000 images | 6,250 | 53,687,091,200 | About 66.67 GiB base64, plus 1 GiB metadata |

These are planned payload arithmetic, not measured occupancy. The inline
synthetic adapter retains the source and immutable extracted images concurrently;
tier 1 therefore needs more than 11.7 GiB before D1, staging, exports and restore
headroom. The initial actual free space was about 8 GiB on the shared APFS volume.
The coordinator confirmed no external volume and requested a suitable path from
the owner. Full retained tiers cannot safely run here at that capacity. Do not
replace their distinct images with shared zero objects, fake successful captures,
or count a host disk preflight as an application rejection.

Admission cases exercise the shipped request-graph repository separately, with
zero fetched source/image bytes. A passing admission assertion is not the accepted
retained-pipeline tier. The request capacity belongs to the synthetic adapter and
must not be reported as capacity of a declared real Source Adapter Version.

## Fault boundary index

These are synthetic/injected faults, separate from retained real-source replay.
The original proofs are reused; the index does not claim every file was rerun
for this campaign. Final local run results must identify their exact commit.

| Boundary / invariant | Exact executable case or cases |
| --- | --- |
| Source upload before D1; lost successful put | `runtime-storage-recovery.spec.ts`: “resume recovers the deterministic object after an upload-before-D1 restart boundary”; “reparse observes and settles the exact writer after a lost successful put response” |
| Interrupted collection batch; duplicate observation prevention | `runtime-collection-batch-replay.spec.ts`: “a Retry Pause inside a batch leaves later requests untouched and resumes without duplicates”; “a hostname Workflow whose batch step errors is superseded by an attempt that replays the batch without duplicate evidence” |
| Exhausted transport retry; exact resumed generation | `runtime-retry-pause.spec.ts`: “transport retry exhaustion pauses the Ingestion Run without failing the request”; “resuming a transport-paused run opens a new bounded retry generation and completes” |
| Abandoned sleeping source writer | `runtime-owner-pause.spec.ts`: “a superseded sleeping child cannot capture when termination fails and collection reopens” |
| Reconciliation interrupted verified work / lost result | `reconciliation-progress.spec.ts`: “verified source documents survive a later read outage and resume without rereading completed documents”; “interrupted preparation resumes verified batches before sealing for review”; `reconciliation-workflow-binding.spec.ts`: “reconciliation commit success survives lost step output without repeating semantic work” |
| Native predecessor changes and generation fencing | `game-reconciliation-fences.spec.ts`: “a changed game predecessor fences native resume/seal”, plus parameterized pause/abandon cases |
| Partial object staging / exhausted retry / immutable resume | `publication-preparation.spec.ts`: “partial object staging exhausts bounded retry and resumes without replacing verified work” |
| Corrupt image, projection, composition and public export | `publication-preparation.spec.ts`: “corrupt immutable image bytes fail distinctly and cannot be resumed”; parameterized “projections/composition rejects corrupted staged bytes without replacing them”; `game-publication-workflow.spec.ts`: “corrupt retained public bytes fail preparation before any head or backup reservation changes” |
| Preparation stale sequence, changed digest, abandonment and deadline | `publication-preparation.spec.ts`: “a stale sequence, changed manifest, abandoned owner and original deadline fence artifact preparation” |
| Late exhausted Workflow and lost dispatch | `publication-preparation.spec.ts`: “an exhausted stale Workflow cannot pause a newer owner's sequence”; “a lost old start replay cannot pause newer work when its original dispatch fails” |
| Public export successor dispatch and 40-attempt exhaustion | `game-publication-workflow.spec.ts`: parameterized “successor dispatch exhaustion retains a fenced pause and exact resume”; “forty durable attempts pause without an implicit advance or another successor budget” |
| Approval response loss; atomic guard failures; unrelated-game contention | `game-publication.spec.ts`: “whole-candidate approval and contention” (retains original case's assertions) |
| Original deadline during verified-backup wait; late execution and rejected resume | New `game-publication.spec.ts`: “whole-candidate approval and backup-wait expiry”; tests 1 ms before and exactly at deadline, then replay/resume and unchanged published state |
| Backup lost import/export result and restart | `backup-recovery.spec.ts`: “a lost import response recreates and journals a fresh disposable target before retry”; “an exact retained export resumes after the R2 put and D1 transition response is lost”; “the Workflow can resume the same owner after an interrupted active attempt” |
| Failed backup cannot authorize next publication | `backup-recovery.spec.ts`: “backup failure reconstructs live search and leaves recovery degraded”; `composed-recovery.spec.ts`: native backup rejects legacy-only simulated restore evidence |
| Actual SQL restoration / consumer invariants / recovery fence | Retained P-001 and Riot native journeys, plus `recovery.spec.ts`; object presence is never a substitute for restored queries |
| Cleanup exact 30 days; acquired reference; lost delete; multipart writer | `evidence-cleanup.spec.ts`: “owner cleanup persists the exact thirty-day eligibility boundary and resumes its intent”; “cleanup cannot race a reference acquisition during the R2 delete and retries a lost delete response”; “an unsettled multipart writer is conclusively aborted and cannot complete after cleanup” |
| Cleanup old ticket incarnation / ambiguous deletion / protected historical bytes | `evidence-cleanup.spec.ts`: “a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations”; “an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence”; “historical published candidate evidence remains retained without any parsed observations” |

## Measurement interpretation and billing dimensions

Local instrumentation is opt-in through `KEEPR_CAPACITY_OUTPUT_PREFIX`. Each
runtime generation writes a separate isolate report. DevTools samples actual
user-isolate V8 used/allocated heap, embedder heap and backing storage; these
fields remain separate. A sampled maximum is a lower bound on a continuous peak,
not proof of the accepted 64 MiB working-set target. CPU profile time deltas are
estimated sample attribution across a stated interval, with idle/program/GC kept
separate. They are not billed CPU or per-durable-unit CPU. Profiling and occupancy
walks add overhead; the unprofiled stress pass is a separate validation result.
Cloudflare documents these local tools for [CPU profiling](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)
and [memory profiling](https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/).

The read-only storage census now includes automatic SQLite indexes. It measures
retained rows and allocated table/index pages, not SQL write counts. Periodic
filesystem census includes coexisting R2, D1, SQL and restore copies, but is not
an atomic or continuous peak and is not unique physical APFS allocation. Owner
route counts include observed polls and retries, not inferred human decisions.

Current primary billing sources were checked on 2026-09-08. No dollar estimate is
made. Required dimensions remain explicit:

- [Workers](https://developers.cloudflare.com/workers/platform/pricing/): requests
  and CPU; local requests and sampled CPU attribution do not establish account charges.
- [Workflows](https://developers.cloudflare.com/workflows/reference/pricing/):
  invocations, CPU, steps and retained storage. Logged step attempts include retries,
  whereas the documented billed step count excludes retries; do not equate them.
- [D1](https://developers.cloudflare.com/d1/platform/pricing/): rows read, rows
  written and storage, including index write effects. Preparations and submitted
  batch statements cannot be added together or substituted for billed rows.
- [R2](https://developers.cloudflare.com/r2/pricing/): storage and operation classes,
  with storage-class-specific retrieval dimensions. Local filesystem size does not
  establish account operation counts or retained-month costs.

Complete service-call execution counts, exact read/write and index amplification,
provider billing observations, continuous isolate peak and per-unit CPU remain
unmeasured by this increment. Do not derive a monthly ceiling or completion SLA
from those gaps. These are open acceptance requirements, not waived targets.
