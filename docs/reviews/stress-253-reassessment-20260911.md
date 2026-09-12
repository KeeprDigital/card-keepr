# Reassessing the #253 stress failure

11 September 2026. Prepared after the owner questioned whether continued tuning
was improving the application or merely satisfying the test. Further optimization
is paused; #253 remains unresolved and the working changes are uncommitted.

## What the work has established

The early changes are substantive: candidate preparation repeatedly reread small
pieces of immutable data and checkpointed too frequently. Bounded grouping and
reuse reduced instrumented method entries from the historical 34,839 to 12,638.
Three hosted native samples on the optimized runtime completed in
13,959–14,131 ms, within the existing 15,000 ms assertion. These are local binding
entry counts and hosted wall times, not provider billing or CPU measurements.

The original full local selection passed all 20 tests on earlier optimized
snapshot `18d818a2`. The latest hosted Product diagnostic on `5ae2021b` still
failed its 120-second body deadline at 127,224 ms. Actual SQL restore and
verification completed, and publication/backup returned at 104,270 ms overall;
export-record collections reached 121,016 ms. Final component assertions were
not completed within the deadline. The corresponding original local Product
case completed all assertions in 76,558 ms. Later request-local read batching
has passed focused recovery/API tests and `check`, but has no performance result.

The detailed [resolution ledger](stress-253-resolution-20260911.md) preserves
failures and separates focused, local, routine-CI and full hosted evidence.

## The contract mismatch

The [owner-approved publication decision](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899)
selects cost-first durable background processing, explicitly without an agreed
completion SLA. Its adjustable export-component target is 8 MiB. Its real
requirements concern bounded work/memory, complete immutable evidence, durable
progress, exact approval, atomic visibility and verified recovery.

The current Product stress test combines capture, reconciliation, private
artifacts, public exports, publication, real SQL export/restore and repeated
consumer/export verification under 120 seconds. It also asserts exactly one
record per export component. That one-record layout may be a current implementation
contract, but it is not established by the higher-level decision as a necessary
product property. Requiring it deserves review before more per-record tuning.

The existing [testing policy](../testing.md#strategy-test-transitions-then-wiring)
says a timeout should detect a hang rather than assert a hosted machine's CPU or
disk speed. Correctness, platform wiring and capacity are separate proofs. The
Product harness deadline is currently being used as if it were a product
performance requirement. The separate native 15,000 ms assertion is explicitly
a performance check and must remain separately identified.

## Application concern

The design achieves bounded individual operations, but bounded does not establish
efficient total work. The latest unmodified local Product log contains 2,007
private-artifact callbacks and 1,265 public-export callbacks for the 1,001-Product
journey. Products also generate Releases, Distribution Contexts and related facts;
these counts are not one callback per input Product, nor billed Workflow totals.
They demonstrate substantial orchestration and storage amplification.

The next architectural question is whether bounded groups of records can share
artifacts and export components while retaining complete inspection, stable
identities, integrity, replay, cleanup and the verified-backup guarantee. The
measurements do not yet establish production cost or justify replacing Cloudflare,
adding queues, or weakening recovery.

## Recommended disposition

1. Retain changes with demonstrated reductions in repeated work and the added
   correctness/resource regressions. Review marginal changes individually rather
   than treating a green stress run as sufficient justification for complexity.
2. Reconcile the current one-record artifact/component layout with the accepted
   byte-bounded partition design. Measure objects, database writes, retained bytes,
   callbacks and recovery work per input record before choosing a redesign.
3. Preserve a complete end-to-end recovery proof and the original large workload.
   Separate correctness/completion from performance evaluation, using an explicit
   hang budget and measured phase/resource reports. Any performance threshold needs
   an agreed workload, environment and requirement.
4. Update #253's acceptance deliberately after that decision. Do not silently
   raise a deadline, remove assertions, move work out of the clock, or claim that
   routine CI or local success completes hosted stress or #275's capacity campaign.

No issue edits, closure, deployment, final commit or acceptance change has been
performed as part of this reassessment. The proposed six-record public callback
budget was reviewed but has not been implemented.
