# Current tests: value, correctness and unnecessary work

12 September 2026. Bounded audit of the current #306 code, snapshot
`d648cb199e5ee2f685830f1c1c1bde6c35038ec8`. No production code, tests, thresholds,
CI policy or existing sealed evidence changed during this audit. The new
counterexample and report remain local for review.

The suite contains necessary protection, expensive repetition, a weak concurrency
assertion and performance requirements whose meaning is insufficiently defined.
Passing #253's selected checks does not establish that every test is necessary
or correctly designed. The previous completion statements applied to that issue's
implementation and measured acceptance, not a review of the whole suite.

## Scope and cost

Inventoried 249 test files: 52 domain, 13 API, 107 ingestion (including ten stress
files), 76 acceptance (including six explicitly extended/benchmark files), and one
shared transport test file. Inspected the suite policy and selection, publication
helpers, expensive retained results, retirement, count-warning, image, pacing,
resource, capacity and backup tests. This is not a line-by-line review of every
one of the 1,559 routine assertions/cases.

The completed local routine run recorded:

| Layer      | Tests | Selection wall time |
| ---------- | ----: | ------------------: |
| Domain     |   307 |              6.12 s |
| API        |    95 |             11.16 s |
| Ingestion  |   794 |            629.31 s |
| Acceptance |   363 |           276.884 s |

The separate full volume/recovery/performance selection contains 20 tests and
took 410 seconds locally. These are measured samples, including each runner's
overhead, not a production capacity claim. Hosted ingestion body durations below
come from the retained complete CI on `8a48b5f9`; they exclude some setup and
must not be treated as whole-file costs or predicted savings.

## Findings and disposition

### 1. Repair the pacing test's assertion of concurrency

[`runtime-host-pacing.stress.spec.ts:53`](../../apps/ingestion/test/runtime-host-pacing.stress.spec.ts#L53)
keeps request start times, requires same-host starts at least 500 ms apart,
and requires the first starts on different hosts less than 500 ms apart.
This establishes neither overlapping execution nor the required interval after
the preceding fetch completes. Its immediate synthetic responses do not force
overlap to be observable.

The [retained counterexample](evidence/testing-value-audit-20260912/pacing-counterexample.mjs.txt)
executes those exact three source predicates with synthetic traces:

| Trace                      | A1 start/end | B1 start/end | A2 start/end | B2 start/end | Current predicates |
| -------------------------- | ------------ | ------------ | ------------ | ------------ | ------------------ |
| Serial, correctly paced    | 0/10         | 20/30        | 600/610      | 620/630      | Pass               |
| Serial, insufficient waits | 0/400        | 410/810      | 820/830      | 920/930      | Pass               |

No fetches overlap in either trace. The second trace waits only 420/110 ms after
the previous same-host completion. This proves a weakness in the assertions,
not a reproduced production scheduling bug. The separate single-host throughput
test does inspect completion-to-next-start gaps, so the suite is not wholly
missing the pacing rule.

Use a controlled gate to hold one host's fetch open and require another host to
make progress before releasing it. Assert same-host non-overlap and
completion-to-next-start pacing separately. Keep a finite failure timeout; do not
use a sub-500-ms cross-host start window as the proof of concurrency.

### 2. Remove oversized setup from a retired-endpoint test

[`reconciliation-export-and-repair.spec.ts:543`](../../apps/ingestion/test/reconciliation-export-and-repair.spec.ts#L543)
collects and reconciles 26 Cards with 490,000-character rules fields each
(12,740,000 characters before serialization) and then asserts the retired run
approval returns 410 without changing objects or the current revision. This
case took 13.509 seconds in the hosted sample.

The [production function](../../src/catalogue/ingestion/publication-lifecycle.ts#L239)
rejects a fresh non-publishing run before export-size handling. Consequently,
this test does not exercise an over-budget publication. The smaller
[`publication-caller-retirement.spec.ts`](../../apps/ingestion/test/publication-caller-retirement.spec.ts#L23)
already tests retirement and the native replacement path.

Retain one small retirement case with the unchanged-state/object assertions;
remove the oversized setup or consolidate those assertions into that case.
Keep actual native export resource-limit tests separately. Preserve historical
in-progress publication recovery, which still has a distinct production path.

### 3. Reduce complete-backup setup where only the next candidate is inspected

The [count-warning cases](../../apps/ingestion/test/reconciliation-workflow-binding.spec.ts#L982)
publish and verify a complete backup in setup before preparing the next candidate
to inspect the 24-versus-25 observation-delta rule. The 25→50 body alone took
12.990 seconds hosted. `approveNativeCandidate` deliberately includes backup
verification, so selecting it selects that cost even when a caller does not
mention backups.

The warning requires the correct retained predecessor counts, not a fresh proof
of SQL restore for each threshold case. Use the existing preparation-only
`seedNativePredecessor` where its contract applies: an actual published
predecessor with backup explicitly pending, followed only by candidate
preparation/inspection. Never fabricate a verified checkpoint or use that setup
for a subsequent publication or recovery test. A narrower real-storage warning
test could separate the rule further if this family is changed.

This is an unnecessary-work finding, not proof that the current assertions are
wrong, and its time saving has not been measured.

### 4. Resolve what the native 15-second requirement means

[`game-reconciliation-scale.stress.spec.ts:114`](../../apps/ingestion/test/game-reconciliation-scale.stress.spec.ts#L114)
checks elapsed time before checking callback counts and sealed state. A timing
failure therefore prevents those final assertions from executing, although the
instrumentation remains available in the report. It also requires more than ten
callbacks, an implementation-shape lower bound with no clear product guarantee.

The actual instrumented interval measured 7.736 seconds locally and 14.277 seconds
hosted. The 15-second assertion is an existing requirement and was preserved in
#306; its pass is real. It does not describe production Worker CPU or a
publication completion SLA. Future treatment needs an explicit decision:
either define a reference environment and meaningful benchmark policy, or make
elapsed time diagnostic while keeping independent resource/completion checks.
Do not silently remove it, raise it again, or call earlier failures passes.
Split timing from correctness/resource results so each is reported independently.

### 5. Consolidate image volume proofs only after retaining their differences

There are two 128-image publication journeys: the [native image suite](../../apps/ingestion/test/native-printing-images.stress.spec.ts)
and the [scale suite](../../apps/ingestion/test/reconciliation-scale.stress.spec.ts#L154).
Both publish and serve 128 × 100 KiB images, but they are not exact duplicates.
The native helper rejects non-streamed reads/writes; the scale case checks
candidate size, exported record identities and complete backup via the shared
publication helper. The source layouts differ too. Their hosted body samples
were 24.360 and 25.824 seconds.

This is a consolidation candidate, not authorization to delete either proof.
A single volume journey would need the union of those assertions, with small
tests retaining any distinct source-layout behavior. The existing two-image
routine streaming proof remains useful. Do not shrink #253's original Product
workload as part of this cleanup.

### 6. Keep real safety and recovery checks

Atomic visibility, stale approval rejection, content/hash validation, interruption
replay, competing writers, cleanup ownership, resource guards and actual SQL
restore protect concrete failure modes. The 101-output replay and large-plan
history regressions previously hit the real callback guard and drove production
fixes. The five new transport tests cover corrupt/incomplete SQL, interrupted
upload, snapshot isolation and parser details that failed during implementation.
Their existence is justified; changing their implementation still requires review.

The release-gate test's many cases protect every required job and failure state
by executing the actual gate. A large case count or reading a workflow file is
not enough to call that test useless. Likewise the 35.203-second artwork history
case contains meaningful identity evolution across several accepted revisions;
its duration alone is insufficient justification to remove it.

### 7. State the limits of capacity evidence

The tier admission cases fetch zero bodies. The >5,000-request completion case
seeds 4,800 already-observed identities and fetches/parses 401 live requests.
Both disclose this in their code and are useful admission/resume regressions.
They do not demonstrate fetching an entire 5/50 GiB catalogue. Keep these tests;
do not present a full-suite pass as usable production capacity. That remains #275.

## What the recent work changed

- Production repeated-work reductions are real: an earlier coherent native
  optimization group reduced instrumented method entries from 34,839 to 12,638.
  The ledger does not attribute a speed benefit to every individual hunk. Real
  callback-limit and safe-replay defects were also fixed.
- The large SQL transport repair is test infrastructure. It allows real local
  snapshots and restores beyond the former whole-string boundary; it does not
  change Cloudflare's production export service.
- Routine image coverage moved from 128 images to two, with the volume proof
  retained separately. Refresh cases were split for clearer failures; the prior
  report explicitly says this repeats setup and does not claim lower total cost.
- The Product hang cap and suite descriptions now distinguish correctness from
  timing. No new user-facing feature was delivered by that acceptance change.
- The latest changes are in open PR #306, not merged into GitHub main at the time
  of this audit. The singleton/grouped experiment supplied a decision to preserve
  the existing format; it supplied no shipping format change.

The process problem was letting individual timeout failures drive successive
production optimizations before establishing the performance requirement and
the test's proper scope. Repeating full local and hosted runs made that feedback
loop expensive. Some work removed real waste and defects; some later complexity
was insufficiently justified and has been quarantined.

## Small next action and stopping point

Do not start another whole-suite rewrite or full performance campaign. First
repair the pacing proof and remove the oversized retired-route setup, retaining
their behavioral assertions. Resolve the native timing policy explicitly.
Treat warning setup and image consolidation as targeted follow-ups when their
files next change. Keep full publication, integrity and recovery checks.

For each change, name the failure it must detect, use the smallest relevant
workload, run that targeted check, and run the required full merge validation
once after the selected changes. Additional full runs need a new failure or code
change to justify them. This audit ran only the tiny assertion counterexample;
it reused the complete retained measurements and did not restart heavy suites.
