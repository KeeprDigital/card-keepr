# Testing reassessment — 10 September 2026

The immediate problem is the amount and kind of work inside individual tests.
Changing test runners or adding more retries would leave those boundaries intact.
Keep Vitest, real D1/R2, the existing controlled Workflow drivers and a small set
of complete wiring proofs. Move everyday correctness checks toward one explicit
transition from a verified starting state. Capacity is a separate responsibility.

## Evidence

| Run / environment | Result | What it establishes |
| --- | --- | --- |
| [PR run 34440733999](https://github.com/KeeprDigital/card-keepr/actions/runs/34440733999), Ubuntu / Node 22 | All nine jobs passed; last ingestion shard finished after about 10m44s | A green run alone did not establish reliability |
| [Actual-main run 34441489628](https://github.com/KeeprDigital/card-keepr/actions/runs/34441489628), `30d88b9b`, Ubuntu / Node 22 | Source refresh timed out at 30 seconds; that shard had 245 passes and one failure | The current merge failure is a test-body deadline, not a cancelled job |
| [Focused run 34442539770](https://github.com/KeeprDigital/card-keepr/actions/runs/34442539770), same main code and two files | Both live and quiet reporting timed out on the same source refresh; about 102–103 seconds per selection | Reporting overhead alone does not explain the failure |
| [Earlier main run 34427209793](https://github.com/KeeprDigital/card-keepr/actions/runs/34427209793) | API Printing backfill timed out at five seconds while migrations were inside the test body | Setup and the transition under test need distinct budgets; already fixed on current main |
| Local baseline, macOS arm64 / Node 26.3.0 / two workers, same two files | Six tests passed in 35.20 seconds | Local performance substantially understates hosted cost; it cannot certify CI reliability |

The current source-refresh scenario combined intake, owner admission, initial
publication, official-only publication, supplemental-only publication, outage
publication, source-proof reuse and conflicting evidence under one deadline.
Its neighboring image case collected and published 128 distinct 100 KiB images
and allowed 120 seconds. Neither shape is necessary to assert a single refresh
rule or the basic streaming contract.

The runtime already has controlled preparation/publication helpers. Some semantic
no-change tests explicitly opted back into real background scheduling for setup.
That duplicates platform scheduling exercised by dedicated binding tests.

## Decisions and coverage

| Concern | Routine proof | Volume / platform proof |
| --- | --- | --- |
| Source refresh | Independent official-only, supplemental-only and optional-outage transitions, each starting from fresh owner-admitted, published, backup-verified evidence | Existing no-change history, cross-game composition and recovery tests retain multi-revision interactions |
| Printing images | Two distinct 100 KiB images, real streamed reads/writes, hashes, serving and export references | The same assertion runs with 128 images in `native-printing-images.stress.spec.ts` |
| Missing required capture | Nine requests: one failure beyond a full eight-request batch; incomplete scope cannot publish | Existing collection capacity suites cover volume |
| No-change publication | Controlled production preparation/publication with real D1/R2, approval guards and SQL restore | Caller-retirement and Workflow-binding suites retain real dispatch/execution/storage proofs |
| Diagnosing the next CI failure | Every ingestion shard uploads test names, failures and durations | A separate manual focused workflow repeats a selection while preserving any failure as a failed job |

Splitting independent refresh cases repeats some setup. This trades a little
total work for isolation and substantially shorter individual test bodies; it
is not represented as an overall speed improvement for that file. Setup still
has a 30-second deadline, fresh storage and real verification. No fabricated
backup checkpoint, shared mutable predecessor or increased timeout is introduced.

The diagnostic workflow is deliberately separate from `ci`; its success cannot
satisfy the production release guard. All existing required CI job names,
shards, routine suites and exact-main release requirements remain in place.
Successful test logging is quieter to make reports usable, not to claim a fix.

## Maintenance rules

For a new behavior, choose its responsible boundary before writing a test.
Use direct domain functions for rules, a real storage transition for persistence,
and a binding or HTTP/CLI test only for wiring that the lower boundary cannot
prove. Reuse the current drivers; do not add a second implementation of the
application in mocks. Avoid tests that read implementation source to predict
behavior. Keep structural tests only for actual structural contracts such as
schema constraints or the release gate.

A timeout requires a focused reproduction and a decision about unnecessary work,
ordering or leaked execution. Do not routinely change timeouts, worker counts,
rate limits or global defaults to achieve one green run. Move large inputs to
capacity coverage only with a bounded proof of their behavioral contract.

Use the retained CI reports to identify the next expensive family when it is
actually changed or fails. This assessment does not justify rewriting hundreds
of already useful tests, changing production architecture just for mocks, or
weakening the merge gate. The goal is less recurring test work.

## Verification

Local focused validation: all 20 tests across source refresh, native image
publication and native no-change publication passed. The eight domain capacity
fixture checks, lint and type checking passed. The separate 128-image stress
assertion also passed locally (23.86 seconds including startup).

[Hosted focused validation 34443587293](https://github.com/KeeprDigital/card-keepr/actions/runs/34443587293)
ran the four changed files three times on Ubuntu / Node 22 at `5b134f54`:
20/20 passed in every run (60 executions, no retries hiding failures). The
routine image case took 3.37–3.43 seconds. The three independent supplemental
refresh cases took 13.07–16.76 seconds including setup and teardown. These are
small samples, not a claim of zero flakes.

That report also identified the existing coverage-loss scenario at 25.62–26.01
seconds against a 30-second body deadline. Its necessary 26-record published
baseline was subsequently moved into scoped setup, preserving the threshold
and all completeness assertions. All seven source-refresh cases passed again
locally after that change. Full CI on the review head remains the authoritative
merge evidence; a diagnostic success never substitutes for it.
