# Test value overhaul

12 September 2026. Implements the bounded findings in
[the test value audit](testing-value-audit-20260912.md) against the existing local
checkout at `fa0a404e4f980914a79825d6ff34f6d9f68e6a48`, including its pre-existing
uncommitted publication/transport work. Those earlier changes are preserved.
This is a targeted overhaul, not a claim that every assertion in the repository
has received a new line-by-line audit. No shipping application behavior, fixture
capacity, CI selection, shard count or production release gate is changed here.

## Disposition

| Audit finding              | Change and failure it must detect                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host concurrency/pacing    | Hold both hosts' first fetches open until the test observes both. Serial fetch execution cannot pass the barrier. Record same-host overlap and separately check each retained completion-to-next-start gap against the configured interval. The finite barrier timeout releases the gate and settles work before teardown.                                                                                                    |
| Oversized retired approval | Remove the unused 26 × 490,000-character fixture and its oversized test. One small, reconciled retirement case now checks 410, unchanged run state, current revision and export objects. Exact native approval pins/replay remain a separate test; historical in-progress recovery is unchanged.                                                                                                                              |
| Count-warning setup        | Both delta-boundary cases retain a real published predecessor through `seedNativePredecessor`, with backup explicitly pending. Controlled preparation then inspects only warning partitions. Deltas 24 and 25 retain their respective absent/present-warning assertions; neither case publishes a successor or pretends backup is verified.                                                                                   |
| Native timing/callbacks    | Native 1,001-Product elapsed time becomes diagnostic after discussion of uncontrolled hardware. Completion and the 100-call callback bound remain independently enforced. Replace the arbitrary more-than-ten-callback assertion with evidence that the observer saw successful storage work. Keep the original 120-second hang timeout and full workload.                                                                    |
| Overlapping image journeys | One native 128 × 100 KiB journey now owns streaming, publication, serving hashes/lengths, exported identities/content references and real SQL backup/restore. Reuse the existing publication driver rather than separate manual preparation loops. The inline 128-image case stops at preparation, retaining its distinct sub-1 MiB candidate bound. Both original inputs are unchanged. The two-image routine proof remains. |
| Safety and recovery        | Preserve atomic visibility, stale approval, hash/integrity checks, interruption/replay, competing writers, cleanup ownership, resource guards, actual restore and the complete 1,001-Product publication journey.                                                                                                                                                                                                             |
| Capacity evidence          | Preserve admission/resume tests and their disclosed limits. No pass establishes full 5/50 GiB capture or maximum production throughput.                                                                                                                                                                                                                                                                                       |

The two image source layouts are not interchangeable: the native transport
fixture's padded structured evidence produces a roughly 2.5 MB candidate, while
the inline fixture has a sub-1 MiB requirement. Consolidation removes the second
complete publication journey, not either representation proof. Native image
coverage now requires every distinct retained image to be read through the
streaming guard, without requiring an implementation to read each image twice.
Export assertions check Printing identity, image role/type/dimensions and digest,
not merely a manifest without embedded bytes.

The memory investigation now runs through the standalone `profile:reconciliation`
command, outside all test tiers, including `test:benchmark --all`. The former
15-second and sampled 64 MiB assertions are observations: no replacement memory
budget has been established. The report retains the 64 MiB historical reference
and explicitly records exceedance. Inspector errors and skipped sampling mark
the report `incomplete`; error-free samples are labelled `sampled`, never a
continuous peak or production-capacity verdict.

Exit zero means the real workload sealed and usable diagnostic artifacts were
written, including any sampling limitations. Missing or invalid samples, workload
failure, report-write failure and the retained 120-second hang guard remain
errors. Empty sample arrays previously produced `Math.max(...[]) === -Infinity`
and could satisfy the upper bound; nonempty, finite, positive samples are now
required. The original source workload and profiler remain unchanged.

The existing tier contract verifies routine exclusion and shard equivalence;
it now also verifies that selecting every benchmark excludes this diagnostic.
Shared acceptance profiling remains separately opt-in through
`KEEPR_CAPACITY_OUTPUT_PREFIX`; that setting was absent in the local environment
and configured CI. The documentation explains keeping it scoped to an individual
measurement command. No configured CI workflow invokes the standalone diagnostic.

The previous 15-second and two-minute results retain their original verdicts.
This policy change does not retroactively pass a failure. Elapsed time still
describes an observed run and can support comparable measurements; uncontrolled
hardware makes it unsuitable as this native correctness test's pass/fail rule.
The separately specified collection-throughput requirement is unchanged.

## Validation

Targeted validation precedes one complete local routine validation. Failed
intermediate attempts are retained in local logs, not relabelled as passes:
combining legacy and native preparation exposed an occupied candidate slot;
applying the inline candidate-size bound to the padded native fixture failed at
2,547,920 bytes. Both findings informed the final separation above.

Two temporary negative controls exercised the repaired pacing test:

- Serializing host fetches failed the concurrency barrier (`expected 1 to be 2`).
- Disabling the real host-pacing wait failed the completion-gap assertion
  (`22` milliseconds versus the required `500`).

Both temporary mutations were restored immediately. The production pacing file
has no remaining diff. The [serial](evidence/testing-overhaul-20260912/negative-serial.txt)
and [pacing](evidence/testing-overhaul-20260912/negative-pacing.txt) failure excerpts
retain those counterexamples. The final pacing test passes with the restored
production code and the repository's existing Promise type target.

Before the standalone diagnostic conversion, the optional memory probe **failed**
its then-enforced resource and observer checks:
the candidate sealed in 8,257 ms, but the two returned heap samples included
101,421,768 bytes (96.7 MiB), above the existing 64 MiB target, and the inspector
timed out on one `Runtime.getHeapUsage` request. The
[result](evidence/testing-overhaul-20260912/capacity-result.json) and
[failure log](evidence/testing-overhaul-20260912/capacity.log.gz) preserve the evidence.
This is a failed, incomplete measurement of the existing implementation, not
evidence that this test-only overhaul introduced a production memory regression.
The default probe includes synthetic source generation inside the application
isolate; the existing external-source variant was not run. The original failure
is preserved; the later diagnostic policy does not turn it into a passing
memory-budget result. No sampling timeout or production implementation was changed.
The temporary probe database was removed after investigation; the retained
result and failure log above remain available.

Final validation ran on Apple M4, Darwin 25.5.0 arm64, Node 26.8.2, pnpm 12.3.4
and Vitest 4.1.11. The [validation record](evidence/testing-overhaul-20260912/validation.json)
retains the selections and verdicts.

| Selection                                                                                   | Result                                                                               | Local selection wall time |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------: |
| `pnpm run check`                                                                            | Pass: lint, formatting, types, generated files, boundaries/cycles and build dry runs |                         — |
| Domain, through `pnpm run test:full`                                                        | 307 passed                                                                           |                    6.79 s |
| API, through `pnpm run test:full`                                                           | 95 passed                                                                            |                   12.64 s |
| Ingestion, through `pnpm run test:full`                                                     | 794 passed                                                                           |                  646.25 s |
| Acceptance, through `pnpm run test:full`                                                    | 363 passed                                                                           |                 274.789 s |
| Four focused stress cases: pacing, both image layouts and native Product resources          | 4 passed; 3 unrelated cases excluded by the explicit name filter                     |                   38.11 s |
| Final pacing verification after adapting the Promise syntax to the repository's type target | 1 passed                                                                             |                    3.50 s |
| Optional native memory probe                                                                | Failed resource/observer checks, as detailed above                                   |                  15.068 s |

The complete routine command exited successfully with **1,559 passing tests**.
The routine case count stays unchanged: the oversized retirement case was
replaced with a small independent one. Removing redundant work does not require
discarding useful behavioral cases. The full stress suite and remaining
opt-in benchmark/extended selections were not rerun; this is not a new verdict
on those selections or closure of the earlier publication/capacity issues.

The audit's ingestion sample was 629.31 s; this run was 646.25 s. No overall
runtime reduction is established by these samples. The directly established
improvements are removal of oversized setup and duplicate publication/restore
work, stronger assertions and clearer measurement policy.

Runtime comparisons with the original audit are observations, not attributed
speedups: the checkout already contains other changes, and the machine is not
a controlled benchmark environment. No repeated full performance campaign is
needed to establish these coverage improvements.

## Manual memory diagnostic follow-up

After the standalone conversion, the 1,001-Product workload sealed in 8,088 ms.
The command wrote its reports and exited zero, with `measurement_status:
incomplete`: two heap samples included 139,414,976 bytes (133.0 MiB), one inspector
request timed out, and two sampling intervals were skipped. The
[summary](evidence/testing-overhaul-20260912/memory-diagnostic-summary.json) and
[command log](evidence/testing-overhaul-20260912/memory-diagnostic.log.gz) retain the
observations. This is successful diagnostic collection with incomplete sampling,
not a passing memory-budget check. The temporary database was automatically
removed after the reports were written. The external-source variant was not run.

The ten focused tier/report/metrics checks passed. Two inexpensive report cases
verify that high memory and observer failures stay visible, and that unfinished
workloads, missing isolates and empty/invalid samples cannot produce a usable
summary. The existing tier case verifies `test:benchmark --all` contains only
the two remaining benchmarks and rejects the retired probe selection. A separate
command check confirmed a missing report destination fails before Worker startup.
`pnpm run check` also passed after the conversion, covering lint, formatting,
types, generated files, import boundaries and both build dry runs.
The 1,559-test full run above predates these two report cases; the full suite was
not repeated for the standalone diagnostic conversion.

## PR assembly

The test overhaul is isolated on `codex/testing-value-overhaul`, based on
PR #306's `d648cb199e5ee2f685830f1c1c1bde6c35038ec8`. It targets that PR's branch
so the review excludes its production, transport, CI and dependency changes.
Merge #306 first, then retarget this PR to main and require CI on the resulting
branch. The original shared checkout remains unchanged.

In the isolated worktree, the frozen install and `pnpm run check` passed.
The affected retirement, native image and count-warning selection passed five
cases across three Worker files (16.43 s); the selection/report/metrics files
passed ten cases (0.83 s); and the four affected stress cases passed (39.92 s).
The Worker commands selected named cases, leaving 18 routine and three stress
cases unselected. Raw [routine](evidence/testing-overhaul-20260912/pr-routine.log.gz),
[metrics](evidence/testing-overhaul-20260912/pr-metrics.log.gz) and
[stress](evidence/testing-overhaul-20260912/pr-stress.log.gz) logs preserve the
successful exits and emitted emulator diagnostics. These are focused checks
of the assembled branch; full hosted CI runs on the PR separately.
