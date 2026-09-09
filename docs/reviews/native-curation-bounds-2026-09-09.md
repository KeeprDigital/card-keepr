# Native curation journey bounds

Frozen integration `73dc849e5c6010c8b4e616523acadb4c2196dbe5` failed two original whole-test 30-second bounds on hosted CI: the 32-revision reconfirmation journey and the persistent Release/relationship curation refresh. Local full-file success did not establish hosted success.

An isolated hosted diagnostic at `64814a3` retained all assertions and allowed 120 seconds only to measure the complete cases. Both passed naturally: 34.451 seconds for reconfirmation and 35.324 seconds for the three-publication refresh; total Vitest duration was 77.69 seconds. This demonstrated finite completion beyond the old bound without changing the production path.

The code change `4e7bf09a0525a363f2c8c453f87a51fadbf8486e` gives only those two complete journeys explicit 60-second limits, an existing repository functional-test allowance. Per-callback service-call, transaction-statement, byte, owner and publication assertions remain unchanged. Independent Standards and Spec reviews against `73dc849e` are clear. Focused Biome validation passes.

A second isolated hosted run at diagnostic `8d238c6d`, containing the exact test changes and **no timeout override**, passes both naturally under their actual 60-second limits. Reconfirmation takes 36.417 seconds and refresh takes 35.846 seconds; Vitest totals 79.95 seconds and the measured process totals 82.04 seconds. The other 60 progress cases are explicitly unselected. Both diagnostic runs use one worker process on separate hosted runners with a finite 300-second outer bound; neither was interrupted. Runtime cancellation warnings remain in the raw logs.

[The evidence manifest](evidence/native-curation-bounds-20260909/manifest.json) retains run links and raw/compressed hashes. Diagnostic workflows are read-only measurements and must never be merged or counted as required release checks. The actual CI job set must still pass after provider integration. The stress benchmark's 15-second assertion is unchanged; #271 and #253 remain open.
