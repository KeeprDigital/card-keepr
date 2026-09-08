# Issue 233 capacity and fault evidence

Campaign base: `0bb3b7d26c6744b4c037d788e6b45c334ae8aa83`, schema 28.
This is a partial capacity and fault evidence report, not a passing capacity certification.
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
of this campaign.

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

## P-001 measured campaign (`2bfc81b`)

```sh
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/issue-233-p001 \
KEEPR_P001_METRICS_PATH=/tmp/issue-233-p001.json \
KEEPR_EVIDENCE_CONCURRENCY_NOTE='Sole heavy campaign, serial native acceptance; static review may overlap.' \
node --test --test-concurrency=1 acceptance/one-piece-two-source.test.mjs
```

The complete declared replay passed in 674.0 s, including six publications,
verified backup checkpoints and restored consumer/image verification. CPU and heap
sampling were enabled; allocation-stack sampling was added only in `2cdb459` and
was **not** part of this P-001 run. Raw reports and local-log hashes are retained
in [the artifact manifest](issue-233-measurements/manifest.json).

| Observed P-001 measurement | Value / scope |
| --- | --- |
| Unique original responses / entity bytes / original header bytes | 26 / 3,690,112 / 13,185 |
| Source records per complete collection / accepted Printings | 15 / 8 |
| Response deliveries including synthetic faults | 174 |
| Verified public export compressed / uncompressed bytes | 8,773 / 11,256 |
| Export records / components | 26 / 26 |
| Retained source database rows | 11,866 at the pre-restore snapshot |
| Allocated table pages / named-index pages | 14,946,304 / 2,744,320 bytes; automatic indexes omitted in this frozen helper |
| Workflow step attempts / sum of step wall durations | 4,566 / 44,575 ms; overlapping durations are not total CPU |
| Workflow D1 preparations / batch submissions / submitted statements | 125,724 / 15,332 / 46,715; not independent executions or billed rows |
| Observed administration GET / POST requests | 249 / 47; includes polling, replay and one expected POST failure |
| Observed consumer GET requests | 102 across original/restored API boots |
| Largest sampled concurrent local logical occupancy | 399,214,906 bytes across the runtime reports; includes coexisting restore copies |
| Ingestion isolate sampled V8 used-heap maximum | **67,715,264 bytes**, 224 samples |
| At that same sample: allocated V8 heap / embedder heap / backing storage | 99,811,328 / 3,610,912 / 4,666,032 bytes, reported separately |
| Ingestion profile coverage | About 667 s; 9,092 CPU profile samples, no measurement errors |
| Driver CPU user / system | 15,501,296 / 2,196,065 microseconds before restored consumer verification |
| Driver lifetime maximum RSS | 632,496 KiB; excludes workerd/CLI children and is not isolate memory |

**The initial memory target failed:** used V8 heap alone exceeded 64 MiB
(67,108,864 bytes) by 606,400 bytes at approximately 639.2 s into profiling.
This is an observed exceedance under profiling, not a provider hard-limit error,
a continuous peak, or an explained memory defect. Sampling overhead cannot erase
that observation. No budget or assertion was relaxed. CPU function attribution
alone cannot identify the retained allocation cause; the next frozen Riftbound
campaign adds sampled live-allocation stacks at its first observed exceedance.

The table/index figures above omit automatic indexes because this campaign ran
before the reviewed census fix at `daaa739`; they are not complete D1 index
occupancy. The final helper has a SQLite regression that verifies both primary-key
and UNIQUE automatic index pages. A later helper change does not retroactively
correct this retained report. The 399.2 MB local footprint is about 108 times the
3.69 MB unique source input across this six-publication journey, **not** an
ordinary refresh amplification factor or a linear forecast for the large tiers.

## New focused outcomes

At `462ccb0`, the exact admission-only tier cases passed. Tier 1 admitted 625
requests in 150 ms. Tier 2 rejected 6,250 planned requests in 80 ms with the exact
`RequestCapacityProblem` / `source_discovery_too_large` facts: capacity 5,000,
used 1, required 6,250. The repository left the run collecting with one root and
zero captures; the collection driver owns the durable pause. The initial
`daaa739` test expected a pause at the wrong seam and failed (1/2); the correction
asserts the actual repository contract and does not change production code.

The same head passed both complete `game-publication.spec.ts` cases in 9.75 s,
including the new backup-wait deadline boundary and the unchanged substantive
contention/atomicity/retention assertions. The generator's two domain cases pass
exact counts/bytes/digests. Generated image bodies are deterministic opaque noise
labelled by the existing synthetic fixture as PNG, **not decodable image files**;
this fixture measures byte transport/storage shape, not image validity.

Both native campaigns use the existing immediate source-host replay mode and
2.2-second owner request pacing. Their elapsed times include local control-plane
simulation and test-driver orchestration; neither is live-source throughput.
The 128-image and Product stress cases use the stress suite's production pacing
configuration, while their fixture injection/capture boundary retains its existing
explicit behavior. No elapsed-time comparison isolates profiler overhead: that
would require a matched controlled run, which has not been performed.


## Riftbound measured campaign (`2cdb459`)

```sh
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/issue-233-riftbound \
KEEPR_RIFTBOUND_METRICS_PATH=/tmp/issue-233-riftbound.json \
KEEPR_EVIDENCE_CONCURRENCY_NOTE='Sole heavy campaign; local isolate CPU and allocation sampling enabled; static review may overlap.' \
node --test --test-concurrency=1 acceptance/riftbound-catalogue.test.mjs
```

The complete declared replay passed: 1/1 test, 1,284.304 s harness duration and
1,279.613 s functional journey. All three publications passed their actual SQL
export/import verification, followed by restored consumer, image, export and
private source-authority checks. The declared inventory contains 1,189 records,
31 initial Errata observations and nine Products. The owner admits six visually
reviewed Printings and 30 additional Card-only identities, resulting in 36 Cards.
The 1,183 unretained images receive injected 404s; this is not complete image
coverage or a 1,189-Printing usable-capacity result.

| Observed Riftbound measurement | Value / scope |
| --- | --- |
| Unique retained bodies / bytes | 14 / 9,340,234; original header-byte census unavailable |
| Source requests / injected missing-image responses | 1,198 / 1,183 |
| Successful retained-body deliveries / bytes delivered | 15 / 9,511,347; the report's generic `response_deliveries_including_faults` field counts these deliveries, not the injected 404s |
| Journey retained snapshots / observations | 15 / 1,260 |
| Retained source database rows | 124,516 at the pre-restore snapshot |
| Allocated table / index pages | 260,894,720 / 48,545,792 bytes, including automatic indexes |
| Workflow step attempts / sum of wall durations | 46,385 / 384,611 ms |
| Workflow D1 preparations / batch submissions / submitted statements | 1,200,158 / 179,125 / 543,257; not executed or billed rows |
| Largest sampled concurrent local logical occupancy | 3,941,169,124 bytes, including source, staging, exports and actual restore copies |
| Ingestion isolate sampled V8 used-heap maximum | **88,569,880 bytes** (about 84.47 MiB) |
| Heap query timeouts / skipped timer intervals | 44 / 67 across four runtime reports; coverage is incomplete |
| Driver CPU user / system, complete journey | 116,975,817 / 11,497,181 microseconds |
| Driver lifetime maximum RSS, pre-restore snapshot | 2,336,224 KiB; excludes workerd/CLI children |

**The initial 64 MiB memory target failed.** The maximum is a measured lower
bound under profiling, not a continuous peak or a provider hard-limit failure.
Segment 1 covers initial collection/admission through the first publication;
segment 2 covers the later published-source journey; segments 3 and 4 cover
restored API/admin boots. Their heap-query error counts are 15, 29, 0 and 0.
The skipped-interval count is recorded on each report's final occupancy sample.

The samples show large decreases as well as growth: segment 1 falls from
67,129,572 to 18,289,080 bytes in approximately three seconds; segment 2 falls
from 78,398,576 to 19,039,068 bytes in approximately 7.9 seconds, and later from
88,569,880 to 29,443,072 bytes in approximately three seconds. These are observed
sample changes, not identified GC events or measured post-GC floors. They do not
prove a monotonic retained leak or explain away the target failure.

The first-exceedance live-allocation samples contain reconciliation, Curated
Revision validation, export validation and backup stacks. They do not account
for the entire heap, identify a dominant cause, or establish exact phase timing:
operational counters are aggregated and CPU sample attribution is not a GC event
trace. The [DevTools sampling profile](https://chromedevtools.github.io/devtools-protocol/v8/HeapProfiler/)
is sampled live allocation attribution, not an exact retained-object census.
No production memory fix, forced collection, budget increase or deadline change
is justified by these observations. A minimal targeted reproduction with phase
correlation remains necessary before a causal fix can be claimed.

The campaign began with 9,147,523,072 free bytes on shared APFS; minimum sampled
free space was 773,509,120 bytes. The final verified database is copied in place,
not into a cloned state directory. The coordinator removed only completed issue
232's reinstallable dependencies to recover roughly 0.32 GiB. Successful cleanup
of this campaign's own disposable state returned free space to about 5.2 GB.
This near-full shared-host run is not isolated storage-capacity evidence. All
four profile reports and the final census were preserved outside that cleanup;
historical failed replay states were untouched.


## Final local validation and open requirements

The runtime implementation under test is `2cdb459`; `c6066e5` adds only the
reviewed reports and normalized artifacts. Validation is serialized across heavy
Worker/native suites, with at most two Vitest workers. The independent Standards
and Spec reviews found no actionable issue through `c6066e5`, including verified
artifact hashes and metric totals.

| Check | Local result |
| --- | --- |
| Domain suite | 234 tests / 42 files passed, 3.68 s |
| API suite, `npm run test:workers:api -- --maxWorkers=2` | 95 tests / 13 files passed, 12.09 s |
| Ingestion suite, `npm run test:workers:ingestion -- --maxWorkers=2` | 707 tests / 83 files passed, 572.00 s |
| Remaining acceptance (63 files, serial split described below) | 53 earlier passes + 37 corrected handoff cases + 250 resumed cases = 340 passing tests (including subtests) |
| Five-game recovery | Earlier preflights blocked; bounded follow-up at `b1d8306` passed 1/1 with actual SQL import (64.715 s) |
| TypeScript, generated Worker types and document validators | Passed |
| Catalogue cycles and module boundary | Passed |
| Lint | Passed with 29 warnings and 15 informational diagnostics; no errors |
| Both Worker packaging dry runs | Passed; dry run only |
| Changed-file formatting against fixed base | Passed for all changed code and artifact files |

The generic `npm run format:check` uses the local branch comparison and reports
six files outside this fixed-base diff. They are byte-identical to `0bb3b7d`:
`src/http/cors.ts`, `src/http/health.ts`, `src/http/public-base.ts`, and
`test/support/fake-publisher/{cloudflare-api,hostnames,scenario}.ts`. Those unrelated
files were not reformatted; the explicit fixed-base changed-file check passed.

Open acceptance requirements remain: both complete retained synthetic tiers;
the failed 64 MiB target and its unexplained cause; complete service-call,
executed/billed D1 and index-write accounting; continuous peak and per-unit CPU;
and evidence sufficient to derive cost/completion targets. The historical
Product-heavy timing failures remain unexplained despite the unchanged passing
reproduction. No capacity acceptance item is closed by a functional pass alone.
Hosted Actions were not used as validation evidence. Exact-SHA live release gates
remain required; this branch neither deploys nor relaxes them.


The five-game recovery journey's unchanged 6 GiB preflight rejected this host
before test execution: 6,120,595,456 bytes available versus 6,442,450,944 required.
After the full ingestion suite, the remaining acceptance launch observed
5,857,894,400 free bytes. The gate was neither lowered nor bypassed. Historical
five-game results remain provenance, not a final-head pass: this branch changes
the shared in-process runtime's optional profiling/disposal lifecycle, so the
historical journey could not substitute for validation of that helper delta.
The later `b1d8306` run below supplies the missing validation.


The initial 63-file serial acceptance run stopped on a concrete stale fixture:
`fresh-baseline-handoff.test.mjs` applied all migrations (source level 28), but
prepared its release request with fixed expected level 27. The first isolated
case reproduced `409 release_preflight_failed` in 1.325 s. A read-only migrated
fixture census confirmed the other bootstrap gate inputs were an empty spine,
no active owners, and healthy recovery. The correction at `847f6cb` uses the
existing `schemaMigrationLevel(source)` query for that fixture request. The same
case passed in 1.616 s, then all 37 cases in the complete file passed in 46.758 s.
Production guards, exact-SHA bindings, destination baseline level 1 and negative
version tests were unchanged. Both review axes found no actionable delta issue.

The stopped run's later file cancellations are consequences of SIGINT, not
additional application failures. Its first 18 files completed successfully;
the corrected handoff file was run separately and only the 44 pending files
were resumed. The artifact command lists preserve this split. The long P-001
and Riftbound commands were not rerun for this unrelated test-fixture change.


The 44-file resumed run passed all 250 tests in 488.415 s at `847f6cb`.
The completed 18-file prefix contains 53 passing tests (34 top-level cases and 19 subtests); with the corrected
37-test handoff file, these cover the intended 63 files with 340 passing tests
across the recorded runs. This is not a claim that the original interrupted
command passed. That resumed run used the handoff fixture correction unchanged.

Shared free space rose above 6 GiB during the serial run, but the final unchanged
five-game preflight measured only 6,390,845,440 bytes against its required
6,442,450,944. The chained test command therefore did not execute the journey.
Both blocked preflight observations are retained. The later `b1d8306` actual
journey closes this validation gap; full retained synthetic tiers remain unexecuted.

The remaining-file command lists are in
[the initial list](issue-233-measurements/issue-233-executed-acceptance-files.json)
and [the resumed list](issue-233-measurements/issue-233-resumed-acceptance-files.json).
Each list was passed to `node --test --test-concurrency=1`; the handoff file used
that same serial command independently. Full local logs and SHA-256 hashes are
indexed by the artifact manifest, including the initial failure, isolated red
case, inspected gate inputs, fixed case, and complete affected-file result.


A final bounded inventory found no single disposable copy larger than 100 MB
owned by this task: successful native campaigns had cleaned their own state,
`.wrangler` was 24 KiB, and remaining successful test directories were each about
7–14 MB. No historical evidence or unrelated application files were deleted to
chase a preflight pass. The final review corrected the prefix count to include
its 19 subtests consistently with Node's later run summaries.


## Bounded follow-up diagnostics

PR readiness did not end locally available measurement work. At `02f82bd`, the
existing 1,001-Product native reconciliation case now retains its per-callback
method counts, returned D1 metadata, relative start, wall duration and returned
continuation phase. It passed in 14.71 s including setup; the measured
reconciliation remained within the unchanged 15-second assertion at **11,904 ms**.
All 1,295 callbacks remained within the unchanged 100-call assertion, maximum 78.
The earlier instrumented observation at `37f19db` also passed (12,106 ms).

```sh
KEEPR_TEST_SUITE=stress npx vitest run --config apps/ingestion/vitest.config.ts \
  --maxWorkers=1 --silent=false --reporter=verbose \
  apps/ingestion/test/game-reconciliation-scale.stress.spec.ts
```

| Observed local callback dimension | Final value / scope |
| --- | --- |
| D1 `first` calls | 15,364; result rows have no execution metadata |
| D1 `batch` / `all` calls | 18,207 / 425 |
| Evidence R2 `get` calls | 135 |
| Total classified D1/R2 calls | 34,131, excluding simulated Workflow control calls |
| Returned D1 metadata records | 49,656 across result-bearing `batch` / `all` calls |
| Returned rows read / written / changes | 310,059 / 61,641 / 18,128 |
| Sum of returned D1 duration | 1,238 ms, local emulator query-duration metadata |

The [D1 return-object contract](https://developers.cloudflare.com/d1/worker-api/return-object/)
provides execution metadata for result-bearing calls. The observer never replaces
`first()` with `all()`, adds queries, captures SQL/results, or alters a production
binding. Counts of metadata records and binding calls differ because one batch
returns multiple statement results. Local metadata is not account billing,
independent index-write attribution, or complete pipeline write amplification.
The driver simulates Workflow control-plane calls; this is a targeted callback
measurement, not the complete real-source request census. Phase labels describe
the returned continuation (or the step name), not an exact instruction trace;
wall duration is not CPU. The raw per-callback report preserves those limits.

At `f733f07`, a bounded 4,096-event ring adds operational-log receipt times beside
isolate samples. It records selected route/step/status/duration fields only,
reports dropped events and malformed/oversized lines, and explicitly uses the
Node observer clock. Stdio buffering can delay receipt; these are not isolate
execution boundaries. A review correction at `ddf17a0` discards oversized lines
through their terminating newline across chunks. Four focused tests pass,
including actual workerd heap/allocation/timeline calibration and the split-line
regression. This synthetic allocation calibration is not a reproduction of the
application's observed memory failure.

```sh
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/issue-233-curated-probe \
  node --test --test-concurrency=1 acceptance/curated-revision-source-changes.test.mjs
```

That small actual CLI/Worker source-conflict probe passed in 8.010 s at `f733f07`.
Its two runtime profiles retained 4 and 9 route observations, no measurement
errors, and ingestion used-heap sample maxima of 16,748,480 and 17,515,160 bytes.
Only two heap samples per isolate were taken because the profiled portions were
short. The probe exercises creation/reaffirmation and source-conflict handling;
it does not reproduce the large Riftbound reconciliation/publication workload,
identify its cause, or rule out transient peaks. The failed 64 MiB observations
remain failures. Earlier full campaigns do not acquire this timeline retroactively.

## Remaining acceptance work by dependency

| Requirement | Current proof | Remaining work and dependency |
| --- | --- | --- |
| Full 5 / 50 GiB synthetic tiers | Exact generators and zero-capture admission outcomes | External local-volume capacity: the corrected lower bound is 18.33 GiB before structured JSON/database/staging/export/restore (two retained base64 copies plus raw images). Larger storage enables execution; it does not guarantee passing application capacity. |
| Five-game final-head journey | `b1d8306`: 1/1 pass, actual SQL import | Earlier attempts failed the unchanged 6 GiB floor; later available space enabled the actual b1d8306 follow-up, which passed 1/1 with SQL import. |
| Memory target / cause | Actual exceedances plus sampled allocation stacks; small conflict probe does not reproduce them | Still locally diagnosable, not a disk-only blocker. A standalone synthetic 1,001 Product collection/reconciliation now reproduces the 64 MiB overrun (see follow-up below); causal allocation minimization remains open. The new timeline supports phase selection in an approved targeted probe; sparse negative samples are insufficient. |
| Complete calls and D1/write attribution | Complete reported counters for the selected D1/R2 callback seam; local metadata for result-bearing methods | Locally implementable broader binding observation remains for collection, preparation, publication, backup and opaque D1 methods. Exact index effects need controlled query/result comparisons; existing counters do not establish them. |
| Per-unit CPU / continuous working-set peak | Local sampled attribution, callback wall time, sampled V8 and backing metrics | Local phase correlation can improve sample attribution, but cannot create exact billed CPU or a continuous peak from missing samples. Provider accounting would require separately authorized provider observations, not a larger disk or a budget waiver. |
| Cost/completion targets | Local wall/occupancy and selected dimensions recorded | Depends on complete representative workload/call/write/CPU evidence and an explicit operating workload; deriving a ceiling now would invent missing measurements. |
| Durable fault matrix | Exact mapped cases below and in the earlier index passed in the full 707-test ingestion suite | The tested named boundaries are established; an exhaustive injection at every durable write within every reconciliation phase has not been demonstrated. That audit/probe work is locally implementable and is not replaced by a green test-family name. |

The fault audit maps the accepted categories to concrete boundaries rather than
claiming an unqualified exhaustive proof. In addition to the earlier index:

| Accepted category / exact boundary | Executable evidence and current limit |
| --- | --- |
| High-degree entity / image or identity fanout | `game-reconciliation-operations.spec.ts`: “a game preparation reports terminal %s failure without failing its collection”, with `capacity-high-degree-observation`, `capacity-printing-image-fanout`, `capacity-card-identity-fanout`. These prove explicit guard failure, not usable high-degree capacity. |
| Successor initialization, dispatch and lost work result | `reconciliation-shards.spec.ts`: “a successor initialization outage exhausts bounded retries and returns the paused operation to its root”; “lost dispatch and work outputs preserve one chain within the shard attempt allowance (attempts=%s)”, attempts 1 and 4; “a Workflow restart preserves reservations made before a lost work result”. These are specific reservation/dispatch boundaries, not every reduction phase. |
| Source-read and verified-batch resume | `reconciliation-progress.spec.ts`: “verified source documents survive a later read outage and resume without rereading completed documents”; “interrupted preparation resumes verified batches before sealing for review”. These exercise retained verified work and resumed batches; they do not enumerate every durable reduction write. |
| Projection/composition partial write and lost success | `publication-preparation.spec.ts`: “%s recovers partial staging and a lost transaction response”, both `projections` and `composition`. Distinct from corruption cases and source upload faults in the earlier index. |
| Inspection content and summary corruption | `publication-preparation.spec.ts`: “publication preparation verifies retained %s metadata as part of the whole manifest”, both `inspection` and `inspection_summary`; asserts `publication_partition_corrupt` before readiness. |
| Approval and backup-wait expiry | The complete `game-publication.spec.ts` contention and backup-wait expiry cases pass; exact deadline and late resume were added without manufacturing a verified checkpoint. Actual restore proof remains the separate native journeys. |
| Cleanup race / terminal age / multipart and old incarnation | Exact cases in the earlier `evidence-cleanup.spec.ts` index passed with the full ingestion suite; this covers those injected boundaries, not every possible process instruction between them. |
| Release/cutover durable phases | The corrected 37-case handoff file covers 12 ambiguous phase writes, 10 correction interruptions, cancellation/retirement/activation outcomes. This is two local SQL databases and simulated provider actions; live cutover and exact-SHA release evidence remain outside this local campaign. |

No new production safeguard, limit, live resource, or account-billing assertion
was introduced by these bounded diagnostics. The draft remains partial while the
locally diagnosable gaps above remain explicitly open.


A more targeted minimization probe at `80587b3` repeats the shipped native
`validateCuratedRevision` boundary 1,000 times against one synthetically seeded Riftbound
Printing using the shipped native validation function. The fixture directly
constructs selected tables/records; it does not replay retained publisher bodies. It preserves and asserts the initial 64 MiB sampled-heap target;
there is no forced GC or production budget change. Ten driver-observed batches
of 100 calls carry monotonic timestamps. The profiler records its observer origin
and explicit 100 ms cadence, leaving the default three-second cadence unchanged.

```sh
KEEPR_CURATED_CAPACITY_OUTPUT=/tmp/issue-233-native-curated-repeat-final.json \
  node --test --test-concurrency=1 acceptance/curated-native-runtime.test.mjs
```

This final probe passed in 3.195 s (2.076 s profile), with 22 heap samples,
**12,429,208 bytes** maximum used heap, zero skipped timer intervals, zero inspector
errors and 218 CPU profile samples. The skip count is now top-level even when no
filesystem census is requested. Earlier sparse and dense probe reports remain
available locally and are hash-indexed; the final report and driver phases are
retained in the artifact directory. This does not reproduce the 64 MiB failure
and is not a minimal reproduction of it. It narrows only repeated validation on
one small retained record; it says nothing conclusive about large retained
candidate state, normalization, publication or backup transients.

After the diagnostics changes, the affected default acceptance tests passed
5/5 in 1.241 s, followed by 4/4 final metric regressions after exposing the skip
count. The affected ingestion-test typecheck passed and changed-code lint passed
with three informational formatting suggestions, no errors. The large suites
and real journeys retain their earlier frozen-commit provenance; they were not
rerun merely for the new optional measurement/probe paths. Final Standards and
Spec reviews include the new code and resolved parser/skip-reporting findings.

## Bounded preparation fault and standalone memory follow-up

At `6f79447`, the verified-preparation regression now distinguishes three exact
third-batch boundaries: rejection before commit; response loss after commit with
the receipt readable; and response loss after commit with receipt reads also
unavailable. The second case completes without pausing because shipped preparation
code verifies the committed receipt. The other cases pause with respectively two
and three verified batches, then resume without source rereads, preserving the
receipt, input manifest and deadline. All cases assert stable sealed replay. The
initial two-case probe incorrectly expected the readable-receipt case to pause;
that test expectation was corrected to match the intended ambiguity recovery.
The final three selected cases passed, and the affected file passed **43/43** in
89.46 s. This adds those boundaries, not exhaustive coverage of all durable writes.

The standalone opt-in probe uses the existing synthetic 1,001 Product fixture,
actual source capture and reconciliation, and a direct test Workflow driver in a
workerd application isolate without Vitest. It excludes publication and backup.
Its original 15 s reconciliation and 64 MiB sampled used-heap assertions remain.
No forced GC, isolate restart, budget change or production fix is involved.

| Frozen probe | Source construction | Reconciliation | Sampled used-heap maximum | Coverage |
| --- | --- | --- | --- | --- |
| `6f79447` | Fixture generated inside application isolate | Sealed, 12,839 ms | **103,179,848 bytes: fails 64 MiB** | 3 samples, 2 heap-query timeouts, 132 skipped 100 ms intervals |
| `6eb3b9e` | Identical generator JSON served by Node over local HTTP | Sealed, 11,653 ms | **69,826,100 bytes: fails 64 MiB** | 3 samples, 2 heap-query timeouts, 117 skipped intervals |

Both processes therefore failed their acceptance assertion. The first report's
assertion surfaced observer errors before checking the memory budget; its recorded
heap still establishes an overrun. The second reports both failures together.
These are observed lower bounds, not continuous peaks or a claim of monotonic
retention. The difference between the two maxima does **not** establish a causal
allocation reduction: moving generation also changes HTTP transport and chunking.

Read-only inspection of the two preserved D1 databases confirms each captured
snapshot receipt has **8,708,711 bytes** and SHA-256
`ddade75e173e535c8108881ff1fd6814a2c93c9c895b116187bdedabf0264dea`,
matching the generated bytes. Source URL and `application/json` media type match;
the Node response additionally records connection/date/transfer-encoding headers.
The separate captured-source receipt artifact preserves this verification without
rewriting either frozen workload report. At `8561698`, future probes distinguish
`generated_source` from `captured_source` and assert the captured receipt against
the generated census. That additional assertion was type-checked; it does not
retroactively change the frozen executions.

At `6eb3b9e`, heap records add `received_elapsed_ms`: together with `elapsed_ms`
(the request-send time), this bounds the observer query window. Neither timestamp
is an exact isolate allocation time. Older files contain only send timestamps.
In the external-source run the first over-limit sample is 68,379,420 bytes over
102.05–369.18 ms, before the first reconciliation step receipt. The final sample
is 69,826,100 bytes over 12,038.04–12,038.47 ms. First-trigger sampled allocation
stacks include collection/capture and D1 dispatch; they attribute only a small
sample of live allocations, not the whole heap. CPU sampling includes JSON
conversion/canonicalization and reconciliation, but does not establish a memory
cause or billed CPU. Fixture generation alone does not explain the overrun. A
bounded workload now reproduces it; capture-path transient allocations remain a
local diagnostic lead. Historical real-source overrun evidence remains unchanged.

```sh
KEEPR_RECONCILIATION_CAPACITY_PROBE=1 \
KEEPR_RECONCILIATION_EXTERNAL_SOURCE=1 \
KEEPR_CAPACITY_OUTPUT_PREFIX=/tmp/issue-233-reconciliation-external \
KEEPR_CAPACITY_SAMPLE_INTERVAL_MS=100 \
node --test --test-concurrency=1 acceptance/reconciliation-capacity-probe.test.mjs
```

Omit `KEEPR_RECONCILIATION_EXTERNAL_SOURCE` for in-isolate fixture generation. Failed
states are deliberately retained. A newer checkout may produce different results;
the table identifies the actual frozen measurements.

Available space later increased independently: the actual temporary-volume
preflight observed 17,141,743,616 bytes, above the unchanged 6 GiB floor. Earlier
preflight rejections remain historical evidence, not the current host state.
The newly unblocked five-game check first failed before execution because a
new fixture import omitted `.ts`; `b1d8306` corrects the import for native Node,
as required by the existing TypeScript configuration. Direct module loading
passes. The corrected bounded five-game check passed at `b1d8306`: **1/1**, 64.715 s test
time (65.280 s harness), with an in-test preflight of 17,157,324,800 bytes. It
verified five-game composition and current plus two through an actual SQL import;
its successful owned state was cleaned up by the existing test teardown. This
closes that previously blocked check, not a full retained tier. No full retained
tier has been executed on the basis of this space change.

One further controlled capture variant at `f747d8a` adds
`KEEPR_RECONCILIATION_CONTENT_LENGTH=1` to the external-source command. It declares
8,708,711 bytes on the same Node-served response. Code inspection showed that
unknown length allocates a 5 MiB multipart buffer, whereas known length streams
through `FixedLengthStream` and a hashing transform into R2. Parsing subsequently
reads the retained body, builds JSON observations and canonical observation bytes;
this sequence does not itself prove simultaneous live retention.

The declared-length variant seals in **11,416 ms**, but sampled used heap reaches
**118,447,544 bytes**, still failing 64 MiB. Four samples, two heap-query timeouts
and 114 skipped intervals leave incomplete coverage. Its first over-limit query
window is 101.77–369.96 ms (71,719,892 bytes); a late window spans
10,485.14–11,800.05 ms (118,447,544 bytes). This is not an exact peak timestamp.
The captured-source assertion passes: length and digest match the prior runs.

The retained capture-path artifact joins each snapshot to its completed evidence
writer. The earlier external unknown-length run records a multipart upload; the
declared-length run records a completed writer with no multipart upload and the
expected captured `Content-Length` header. This verifies the branch difference
from durable records, not merely the supplied server header. Multipart buffering
is therefore **not necessary** for this bounded overrun. The higher observed
maximum does not establish that declaring length causes a regression: sparse
sampling, garbage collection and HTTP framing remain relevant. No production
buffer, parsing behavior, limit or GC policy changed. This is the last executed
memory variant in this follow-up; source parsing/canonicalization is an unresolved
local lead, not an established cause.

## Remaining concrete work after the bounded probes

| Gap | Next bounded action / completion evidence | Dependency |
| --- | --- | --- |
| 64 MiB cause | Inspect the lifetime overlap in `parseSnapshot`: retained-body `arrayBuffer`, decoded JSON/observation graph, recursive `canonicalJson` strings, then UTF-8 observation bytes held across hashing/R2 writes. The CPU profile contains canonicalization, and collection already crosses the threshold, but simultaneous live size is unproven. Allocation tracing aligned to those boundaries in the existing 8.7 MB reproducer could distinguish transient string/graph allocation from later retained state. | Locally diagnosable without another full campaign. Current periodic inspector requests time out behind long work and the delayed live allocation profile cannot establish short-lived allocation totals. Any debugger/instrumentation overhead must be separated from the unchanged timing target; no forced GC or budget increase. |
| Durable reduction ambiguity | Highest-priority unmapped seam: commit a Product-group reducer-state batch, lose its response before the enclosing Product cursor checkpoint advances, then resume and compare typed relationships, counts and sealed replay with the uninterrupted result. Existing Product-group test throws **before** `target.batch`; the Product-pass cases deny checkpoint reads. | Small existing `product-typed-relationships` fixture. Lost committed writes in individual prior/new Product/context/relationship reduction stages are not established by the mapped tests; the verified-preparation receipt test is a different boundary. A complete write-boundary map remains required before calling coverage exhaustive. |
| Complete service and write attribution | Extend observation beyond the selected callback seam to collection, preparation, publication and backup; distinguish returned D1 metadata from opaque calls and index effects. | Local binding counters can improve call coverage; provider/billed CPU and index costs cannot be invented from local return metadata. |
| Full retained tiers | Use the lower bound below plus a complete SQL/staging/export/restore and margin estimate before choosing storage and executing a tier. | Current host is insufficient even for the corrected tier-1 lower bound. Tier-2 admission also exceeds the existing request guard. |
| Cost/completion ceilings | Derive only after representative workload and complete resource dimensions are available. | Missing evidence above; no defensible numeric ceiling yet. |

The corrected storage lower-bound artifact is a **code-derived estimate**, not
measured occupancy. The fixture embeds images as `content_base64`; the source
snapshot retains it and `parseSnapshot` retains it again inside each observation
value. For tier 1, exact base64 rounding totals 7,158,320,000 bytes per copy. Two
copies plus the required 5,368,709,120 raw image bytes total
**19,685,349,120 bytes (18.3334 GiB)**. Tier 2 analogously needs at least
196,853,491,200 bytes (183.3341 GiB). These deliberately exclude structured JSON,
SQL tables/indexes/WAL, staging, exports, backup/restore copies and safety margin.
The latest temporary-volume observation is 16,965,410,816 available bytes, below
even that tier-1 lower bound. The earlier “over 11.7 GiB” estimate counted only
one base64 copy and raw images; it was insufficient for peak-retention planning.
This establishes why increased space enabled five-game validation but still does
not justify executing a full retained tier.
