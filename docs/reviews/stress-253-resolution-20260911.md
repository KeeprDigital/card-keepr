# Stress resolution continuation, 11 September 2026

Continues [#253](https://github.com/KeeprDigital/card-keepr/issues/253) from local
`fa0a404e4f980914a79825d6ff34f6d9f68e6a48`. Earlier complete failures, the
45-minute cancelled run and its incomplete evidence remain recorded in
[the first diagnosis](stress-253-20260911.md). This continuation preserves every
original stress fixture, behavioral assertion, test deadline and the separate
15,000 ms native performance assertion.

The [evidence manifest](evidence/stress-253-resolution-20260911/manifest.json)
retains compressed logs and reports with SHA-256 checksums.

## Measurement conditions

Node 26.8.2, pnpm 12.3.4, Vitest 4.1.11, Cloudflare Vitest plugin 1.1.6,
plugin Miniflare 5.20260908.0-alpha and workerd 1.20260908.1; schema 32 unchanged.
Local measurements use the same M4 arm64, 10 logical CPUs and 16 GiB machine.
Heavy local commands run sequentially; hosted jobs use independent runners.
Times and instrumented method entries are neither provider CPU nor billing usage.

Diagnostic snapshots are retained on `codex/stress-253-resolution-20260911`.
They exclude unrelated working-tree planning documents. The hash/cache validation snapshot is `016b1c8d127b7ca932c3f277b7edadfd702abef2`.
The private-object batching snapshot is `ffc6a7b0e197b9c120a87ae0c4eaf256b1e62a62`;
the six-unit checkpoint snapshot is `18d818a287efcf01e167e7ed8261abce9c3dfd3c`.
Final hosted validation remains pending.

## Changes and causal evidence

Repeated single-row reads and checkpoints dominated candidate preparation.
Bounded source/reducer pages and grouped writes now amortize that work. Input
and output groups retain byte limits, ordered prefix verification and exact
immutable-effect checks. Pending effects flush before their durable cursor.
Preflight reads share one batch; live generation fences still guard writes.
Absent official identities are cached only inside one bounded input group and
invalidated by an affected Card write or resume. Existing identities keep their
complete lookup and admission path.

Source history batches new observations and their entity counts, reuses the
current plan iterator, and counts hydrated input bytes before continuation.
Product output replay verifies conflicts in bounded batches rather than one read
per existing effect. An ASCII fast path counts UTF-8 token bytes without allocating
an encoder buffer; non-ASCII tokens retain actual UTF-8 encoding.

Backup verification pages up to 128 rows within the existing 1 MiB limit.
It still hashes every ordered row before export and after real SQL restore.
A new real-SQL fixture crosses the 128-row boundary; the existing UTF-8,
oversized legacy row and changed-restore tests remain intact.

Two regressions found during review each failed at the real 100-call resource
guard before the fix and passed afterward: replaying 101 uncheckpointed outputs,
and processing 32 retained plans with 1.5-million-character facts. The replay
case also rejects a changed immutable effect. The complete resource file passes
all seven cases. Existing identity, cursor, normalization, history and publication
recovery files were exercised throughout the change.

## Hosted diagnostic progression

All native samples below retain the same 1,001-Product fixture and 15,000 ms
assertion. These are independent single samples, not a statistical benchmark.

| Snapshot   | Run                                                                                | Native elapsed | Result                   |
| ---------- | ---------------------------------------------------------------------------------- | -------------: | ------------------------ |
| `17987565` | [34571931545](https://github.com/KeeprDigital/card-keepr/actions/runs/34571931545) |      30,225 ms | Failed elapsed assertion |
| `6c339024` | [34573049054](https://github.com/KeeprDigital/card-keepr/actions/runs/34573049054) |      25,302 ms | Failed elapsed assertion |
| `a570a916` | [34574274044](https://github.com/KeeprDigital/card-keepr/actions/runs/34574274044) |      23,028 ms | Failed elapsed assertion |
| `fc35acf2` | [34575935451](https://github.com/KeeprDigital/card-keepr/actions/runs/34575935451) |      14,246 ms | Passed                   |

The passing native sample recorded 986 callbacks, 12,638 instrumented method
entries and at most 41 calls per callback. Its 754 ms margin motivated a separate
three-run check and final full selection; this focused result alone is insufficient.

The four-case [512 MiB hosted run](https://github.com/KeeprDigital/card-keepr/actions/runs/34576069811)
on `fc35acf2` completed with one pass and three failures. Cards passed in
120,054 ms. Product publication failed after 117,424 ms with `SQLITE_FULL`;
images and warnings then failed immediately because the same volume remained full.
This is storage exhaustion, not a completed Product restore/export result.
Full/focused stress now uses a disposable 2 GiB tmpfs and reports occupied bytes
before cleanup. Routine and bounded stress retain 512 MiB. Existing real SQLite,
R2 isolation, SQL restore and job caps remain enabled. Local backing is unchanged.

The unmodified Product test completed locally in 98,834 ms with all original
restore/export assertions. A 25.9-second inspector sample during that run located
cost in export preparation, R2 access, deterministic compression and snapshot
hashing. It is diagnostic evidence; the final hosted result remains authoritative.

The [three native repeats](https://github.com/KeeprDigital/card-keepr/actions/runs/34577063293)
on `59c734da` passed at 13,959, 13,835 and 14,131 ms. The
[2 GiB scale selection](https://github.com/KeeprDigital/card-keepr/actions/runs/34576737217)
on `d5c561ac` completed three passes and one failure: Cards 105,582 ms,
Product 147,904 ms (120-second deadline), images 35,323 ms and warnings 14,823 ms.
No storage-full error remained. The printed final tmpfs occupancy (114,688 bytes)
was after Vitest cleanup; it is not peak storage usage.

A subsequent phase measurement placed 40.8 seconds in private artifact preparation
and 21.2 seconds in backup/restore locally. Private preparation reread, rehashed
and reparsed the same candidate partition for every record/text subunit. It now
retains one verified partition across the existing four-unit callback; ordinal
changes and every subsequent callback reread and verify storage. It adds no
cross-callback cache, larger batch or omitted integrity check.

Backup and composition hashes that complete within one operation now use
`node:crypto` SHA-256, preserving ordered byte chunks and streaming. Resumable
hashes retain their existing serialized state implementation. Both Workers already
enable Node compatibility; [Cloudflare supports this API](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).
A golden digest recorded before the replacement checks Unicode, escapes and null
fields. All 16 snapshot domain tests and 34 publication/backup Worker tests pass.
The instrumented backup phase fell from 21.2 to 15.5 seconds. These are diagnostic
single samples; the performance verdict comes from the original hosted test.

## Final verification

- `pnpm run check`: passed, including lint/format, types, generated files,
  import boundaries and both Worker build dry runs.
- Standards review: no hard violations; optional duplicated bounded-group loop.
- Spec review: both resource findings fixed; no further actionable findings.
- [Bounded stress 34576907082](https://github.com/KeeprDigital/card-keepr/actions/runs/34576907082): passed.
- [Full routine CI 34576905279](https://github.com/KeeprDigital/card-keepr/actions/runs/34576905279): all nine jobs passed on `59c734da`, before the final hash/cache changes.
- [Full routine CI 34578019265](https://github.com/KeeprDigital/card-keepr/actions/runs/34578019265): all nine jobs passed on `016b1c8d`, including the final hash/cache changes.
- [Hosted scale 34577998113](https://github.com/KeeprDigital/card-keepr/actions/runs/34577998113) on `016b1c8d`: three passed; Product failed its unchanged deadline at 163,908 ms. Cards passed at 115,789 ms, images at 41,879 ms and warnings at 17,501 ms. The later local 91,538 ms Product pass does not supersede this hosted failure.
- [Isolated hosted Product profile 34578680850](https://github.com/KeeprDigital/card-keepr/actions/runs/34578680850), diagnostic snapshot `364379e7`: failed at 164,056 ms. Same Product fixture/assertions/120-second deadline, selected in a temporary diagnostic copy. Candidate preparation finished at 21,848 ms; private artifact preparation took 88,317 ms. Backup snapshot capture took 5,953 ms, followed by 13,573 ms of artifact verification; remaining restore/export assertions were not reached in the retained phase trace.
- Local full selection on `016b1c8d`: all 20 original tests across all 10 files passed in 433.31 seconds. The native case took 8,706 ms. This local result does not replace hosted acceptance.
- [ARM64 isolated Product profile 34579384138](https://github.com/KeeprDigital/card-keepr/actions/runs/34579384138), diagnostic snapshot `97e7cff9`: failed at 174,818 ms. Only the diagnostic runner changed to `ubuntu-24.04-arm`; the same fixture, assertions and deadline remained. Private preparation took 94,334 ms, so changing runner architecture did not resolve the bottleneck. Main workflows retain `ubuntu-latest`.
- Private metadata now stages at most four objects and 512 KiB before writing. All writer tickets commit before PUTs begin; successful responses settle only their own tickets, ambiguous writes remain open, and all writes and verification settle before receipt/cursor commit. Buffered content is released after verification. The 45 publication and cleanup tests pass, including a late-write/ambiguous-response regression. A previous test assumed one serial PUT; it now verifies every staged object's single PUT, retained bytes and reuse after retry.
- [Hosted Product batching profile 34580831663](https://github.com/KeeprDigital/card-keepr/actions/runs/34580831663), diagnostic snapshot `b84c68f7`: failed at 145,955 ms, with private preparation down to 71,744 ms from 88,317 ms. Candidate preparation finished at 21,400 ms; backup snapshot and artifact checks consumed 5,884 and 13,684 ms respectively. The deadline and remaining assertions were unchanged.
- The unchanged local Product test passed in 95,536 ms with batching. Private Workflow step durations summed to 33,955 ms; this differs from the earlier phase probe's inclusive boundary and is only diagnostic. The six-unit local Product test passed in 78,682 ms. Original hosted scale, full routine CI and the final full hosted stress remain pending.

Usable 5/50 GiB capacity remains owned by #275; this suite does not certify those
tiers. Durable fault coverage remains owned by #276. No live deployment or
publisher capacity campaign was performed.

## Six-unit resource accounting

Private preparation now processes up to six sequential units, flushing at four
pending objects or 512 KiB. Composition nodes still commit singly, and phase
boundaries still commit before reading staged receipts. Review independently
bounded the worst path at 96 calls: 70 object operations, 12 lifecycle reads,
one partition read and 13 fixed/fence-recovery calls. Six producing projection
units cannot also advance six partitions; each partition advance consumes a unit.
The unchanged hard callback guard remains authoritative.

Five small units plus a maximum projection and lifecycle bind at most 960 KiB,
leaving 64 KiB for fixed receipts and cursor data. Six export-text units bind at
most 768 KiB; search chunks are at most 48 KiB each. Phase boundaries prevent
mixing those byte cases. The 52 focused publication, cleanup and resource tests,
type checks and complete local `check` pass on this version.

## Public export and backup follow-up

On `18d818a2`, the complete local selection passed all 20 tests in 409.93 seconds
(Product 82,883 ms; native 8,737 ms), and [routine CI 34581228574](https://github.com/KeeprDigital/card-keepr/actions/runs/34581228574)
passed all nine jobs. The original [hosted scale selection 34581226484](https://github.com/KeeprDigital/card-keepr/actions/runs/34581226484)
still failed Product at 138,348 ms; Cards passed at 104,652 ms, images at
39,622 ms and warnings at 16,564 ms. This failure remains unresolved by the
local pass. [Bounded stress 34581499483](https://github.com/KeeprDigital/card-keepr/actions/runs/34581499483)
passed on `1913f3f9`, whose only change was reliable cleanup in the new fault test.

The next change applies the same ownership batch to public compressed components:
at most four objects and 4,000,000 compressed bytes are retained and verified
before any cursor or component receipt commits. The four-record rendering bound,
80-call estimate, raw-byte limit and one-record-per-component format remain.
Backup artifact verification reads at most four leaves together; upper tree
levels stay sequential, leaf nodes cannot recurse, and all reads settle before
failure propagates. Invalid references are rejected before opening bodies and
size mismatches cancel the body. Hashes and ordered manifests remain unchanged.
All 47 affected publication/recovery tests and both review axes pass. Further
performance and final hosted validation remain pending.

## Remaining Product deadline diagnosis

The public-component/parallel-leaf change completed locally at 77,800 ms, but
[hosted Product profile 34582314360](https://github.com/KeeprDigital/card-keepr/actions/runs/34582314360)
on diagnostic `6da971a4` still failed at 122,159 ms. Candidate preparation took
20,044 ms, private preparation 57,756 ms, and backup snapshot/artifact checks
6,038/8,973 ms. The trace ends before SQL export/restore: the reported failure
is not evidence that the complete workload needs only another two seconds.

Private exports now process up to eleven units, with the existing text-byte
stop condition; projections remain at six. Metadata read-back hashes consume
streamed chunks through `node:crypto`, with cancellation and reader release on
failure. The original local Product case passed at 77,733 ms. The next
[hosted profile 34583288056](https://github.com/KeeprDigital/card-keepr/actions/runs/34583288056)
on diagnostic `3c2577c6` still failed at 125,164 ms: candidate preparation
21,635 ms, private preparation 58,489 ms, backup snapshot/artifact checks
5,733/11,029 ms. Later restore/export phases remain absent. Changing the shared
text hash was rejected after a 10,000-hash microcomparison found only a 9 ms
difference; `sha256Text` remains unchanged by this experiment.

Snapshot `1c43bcb3429168b1abc904eff8a550c808fbc6bd` reduces repeated storage
bookkeeping. Four writer tickets now use two set-based admission statements and
one completion statement, retaining per-ticket identity and all triggers. An
initial ordinary JOIN chose a binding-only scan and worsened the local Product
run to 105,453 ms. The corrected CROSS JOIN keeps the four input rows outermost
and uses the complete object primary key. The retained query-plan comparison
is a local SQLite diagnostic, not a provider query-cost claim.

Private metadata batches check up to four identities in the durable registry.
Registered identities retain the tracked HEAD path, including ambiguous-write
settlement; new identities use conditional PUT followed by full read-back/hash
verification. An unregistered existing object cannot be overwritten or silently
repaired. Conditional collisions are recorded as reused. A new real-D1/R2
regression verifies that corrupt pre-registry bytes survive, partial batches
produce no receipts, and known write outcomes settle their own tickets.

Public query facts are extracted once for the existing group of up to six
projection ordinals, after those projections and before cursor commit in the
same transaction. The entity, nested attribute and release-region queries
retain their original extraction and distinctness rules. The 46 publication/
cleanup tests, 30 publication/replay tests, complete `check`, and both review
axes pass. Independent review bounds projections at 99 calls and exports at 97,
including final-fence handling. Four open bodies and the 1 MiB binding bound
remain unchanged. Final performance validation is still pending.

The [next hosted Product profile 34584985110](https://github.com/KeeprDigital/card-keepr/actions/runs/34584985110)
on diagnostic `5ae2021b` failed at 127,224 ms. Candidate preparation took
16,350 ms and private staging 41,817 ms. This run reached actual SQL restore and
verification: the whole publication/backup boundary completed at 104,270 ms.
The three export-record collections finished at 121,016 ms, after the unchanged
deadline, leaving final component assertions unverified. The corresponding
unmodified local Product case completed all assertions in 76,558 ms.

The next read optimization batches request-local revision/receipt/readiness
queries for public exports, plus each manifest page's artifacts and supported
games. The four-component page format, deletion status precedence, legacy
fallback and every per-request R2 integrity check remain. All 26 API runtime
tests pass. Publication preparation also groups candidate/owner and preparation
status reads after the replay lookup. The lost-commit regression initially
failed because it injected an error after the first batch, now a read. It now
observes the durable action receipt before losing that transaction response,
so it exercises the intended cursor-commit boundary rather than a read outage.
