# Publication architecture reassessment: decision and comparison

11 September 2026. Start from [#253](https://github.com/KeeprDigital/card-keepr/issues/253).
**Keep the existing platform and public format for now. Separate the large
journey's correctness acceptance from performance measurement before further
production tuning.** The next bounded engineering investigation should address
the demonstrated local SQL-export failure and account for retained history,
including unchanged publication. Public grouping reduced consumer work, but this
prototype did not establish a dependable improvement to background completion.

No production code, original tests, timeout, public schema or issue acceptance
was changed in the primary checkout. The uncommitted starting work and both
unrelated planning files remain intact. The alternative format and instrumentation
exist only in an isolated detached worktree and retained patches.

## Requirements and decision boundaries

The [requirements review](publication-253-requirements-20260911.md) distinguishes
the following, using issues #214, #216, #253 and #275, the domain docs and current
Cloudflare documentation:

| Category                      | Meaning here                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Required correctness/recovery | Complete exact candidate approval; verified immutable data before a fenced atomic switch; backup reserved with that switch; actual independent restore before another switch; safe replay, interruption and cleanup; original seven-day deadline |
| Platform/resource limits      | Worker, Workflow, D1 and R2 constraints; bounded callbacks and payloads remain necessary. The repository's 100-call/four-body guards and 64 MiB target are distinct from platform limits and test wall time                                      |
| Adjustable choices            | Approximate 8 MiB export target, batch sizes and engineering headroom. The accepted design has **no publication completion SLA**                                                                                                                 |
| Current public contract       | Exactly one record per component and at most four components per manifest page. Grouping requires an explicit, coordinated contract change                                                                                                       |
| Test assumptions              | The Product journey's 120-second cap is separate from the native candidate's **less-than-15,000 ms** performance assertion                                                                                                                       |

Publication frequency, full versus incremental consumer downloads, monthly budget
and acceptable background completion window remain unspecified. There is no
evidence-based reason to turn 120 seconds into an application requirement.

## What the isolated experiment proved

Both layouts used the current uncommitted production functions, real local D1/R2,
the original 1,001-Product fixture and its 4,006 public records. Both retained
publication, candidate/manifest integrity, reference, size, stored-digest and
actual SQL backup/import/restored-content checks. An additional complete consumer
pass decompressed and validated every record and both compressed/raw digests.
All corresponding catalogues and raw entity identifier sets matched.

The grouped variant used at most four records and a 256 KiB raw ceiling within
stable identity-prefix ranges. Pages still held at most four components. It
changed only public packaging; private preparation stayed unchanged. This is an
explicit alternative format experiment, not a pass of today's singleton format.
Four records is a conservative pilot size within the existing 80-call rendering
estimate. The observed largest group was only 16,580 raw bytes; this experiment
does not establish the best size or exercise the proposed byte boundary.

Heavy measurements ran sequentially on the same toolchain. Each layout completed
two independent histories: full→unchanged and full→one Card name changed. All
**eight large publication checkpoints** actually restored. Separate 64-Product
lost-write-response/replay probes also completed publication and restore.

| Observation                                 | One record/file | Grouped prototype |
| ------------------------------------------- | --------------: | ----------------: |
| Full journey, two samples                   |   75.3 / 97.0 s |     74.2 / 75.8 s |
| Unchanged journey                           |         130.7 s |           109.7 s |
| One source fact changed, journey            |         133.9 s |           133.3 s |
| Full public components                      |           4,006 |             1,378 |
| Full public preparation callbacks           |           1,265 |             1,473 |
| Full compressed catalogue                   |        8.854 MB |          8.226 MB |
| One complete consumer pass, R2 GETs         |           5,008 |             1,723 |
| Changed components / reused components      |   2,002 / 2,004 |         691 / 687 |
| Changed-object download bytes               |        4.588 MB |          4.123 MB |
| Unchanged public objects requiring download |               0 |                 0 |

MB is decimal. Journey time includes the original assertions and extra complete
consumer pass, so it is not just publication time or directly comparable with
the old uninstrumented stopwatch. The first full publication plus verified
backup took 55.1 versus 62.0 seconds; in the second full sample it took 74.7
versus 62.1 seconds. This variability and the grouped callback increase prevent
a reliable speed claim. Each changed/unchanged case has one sample per layout.

Grouping clearly removes many files and consumer requests. Its one-group-per-
callback implementation also underuses some callback capacity, whereas the
baseline advances several singleton units. That explains why fewer files can
mean more callbacks. It does not prove that all grouped implementations are
slower, nor justify another round of tuning to force this prototype to win.

Changing one Card name changed only one factual record, but current lifecycle
output also changed 2,001 other public records. Thus this is **one changed source
fact**, not a synthetic one-public-file replacement. All lifecycle fields were
retained in the equivalence check. The observed incremental savings should not
be generalized to a different change pattern.

An analytical insertion probe using actual Product memberships replaced one old
group with two and retained 339 other groups. Identity ranges contain the spread
of membership changes; they do not prevent all later descriptor ordinals from
moving. This was not an actual inserted-record publication. The prototype also
rejects an assembled group above its byte cap rather than splitting it, and
does not yet preserve the full existing large-record policy. These limitations
and missing failure classifications are explicit in the
[independent experiment review](publication-253-experiment-review-20260911.md).
It is not ready to promote.

## The larger cost and recovery finding

Reusing public exports does not make publication cheap. In the singleton
full→unchanged pair, retained D1 size grew from 211.3 to 509.7 MB and the second
SQL export was 411.0 MB. The grouped pair grew from 203.5 to 501.9 MB with a
406.9 MB second SQL export. Unchanged acceptance still performed 2,304 private
callbacks, created 2,264 publication-artifact objects, and ran a new verified
backup. The backup interval was approximately 39 seconds in both layouts.
Candidate callbacks also increased from 986 on the first publication to 9,571
with predecessor history, in both layouts. The public file format cannot by
itself remove that repeated reconciliation work.

A prior full→unchanged→changed trial failed on its **third real SQL export** in
Miniflare's whole-dump JSON serialization (`Invalid string length`). The first
two backups restored; the third did not. Fresh pairs allowed equal-history
packaging comparisons, but do not repair or certify that longer history.
The [failure diagnosis](publication-253-emulator-export-limit-20260911.md) identifies
the local export transport and a bounded follow-up. Production uses a streamed
download from a different export API; the observed local failure does not prove
a production database ceiling.

The [complete cost tables](evidence/publication-253-comparison-20260911/measurements.md)
retain every final sample's phase time, storage requests/PUT outcomes, D1
statements and available row work, object/database retention, SQL bytes/import
work and retry work. Grouping reduced first-publication SQL size by only about
2.5%, and unchanged SQL size by about 1%. It does not address the dominant
retained-history growth demonstrated here. No records or recovery data were
pruned to obtain the completed pairs.

After a successful R2 write response was deliberately lost, the singleton probe
retried four PUTs and reused all four persisted objects; the grouped probe
retried and reused one. Subsequent committed replay performed three D1 statements
and no R2 work in either case. This measures bounded repeated work at one exact
failure point, not a platform instance kill or all possible failure paths.

All timings, requests and database metadata are **local emulator observations**.
Sampled process-tree RSS peaked at roughly 4.7 and 4.5 GiB, including runner,
emulator, database/export/restore and buffered verification. It does not measure
a production isolate's working set or certify either memory bound. Production
CPU, independent index-write accounting and billing remain unavailable.

## Smallest justified next change and acceptance

Adopt the [test acceptance proposal](publication-253-test-acceptance-proposal-20260911.md)
as an explicit decision before changing the gate: preserve the entire large
workload and all substantive checks; report performance separately; propose a
**300-second finite Product hang cap** instead of 120 seconds. This is a newly
documented test condition, not a publication SLA or a retrospective pass. The
isolated paired experiments used their own finite 900-second test bounds and
1,200-second process watchdog. Neither existing timeout was edited.

The original native performance test was rerun separately against the primary
working tree: **7,401 ms measured preparation**, below 15,000 ms; test body
8,518 ms. That is one local result, not hosted or full-suite validation.

Then reproduce and improve the existing local SQL-export/restore transport at
its failure boundary, while accounting for retained private history on no-change
acceptance. Preserve complete SQL/schema content and the exact restore proof.
This addresses a demonstrated obstacle to longer-history testing without adding
infrastructure or weakening recovery. Do not skip no-change backup or private
history on the basis of these observations alone.

For occasional publication, keep the simpler current packaging while that work
is completed. If many consumers repeatedly download the whole catalogue, the
measured 66% reduction in files/GETs is a reason to consider a deliberate grouped
format follow-up. For mostly incremental downloads, first establish the real
change/lifecycle pattern and metadata rewrite cost. Any format proposal must
finish deterministic byte splitting, large records, insertion/deletion and
recovery/cleanup validation before adoption.

## Disposition of the existing diff

The [file-and-hunk disposition](publication-253-diff-disposition-20260911.md)
covers all 47 initially modified tracked files and the pre-existing evidence:

- **Retain:** bounded removal of repeated reads/hashes/transactions, callback-local
  verified partition reuse, real backup paging/native hashing, bounded staging
  and public/leaf batching, together with their replay/ownership/corruption tests.
- **Keep modest simple changes, with speed unproven:** local read batching and
  already byte-bounded page-size choices. Do not attribute the whole speedup to
  each constant.
- **Simplify next:** the special eleven-unit private export allowance lacks a
  demonstrated worthwhile benefit. Isolate a return to the earlier six-unit cap
  and validate that hunk, keeping batching and byte guards.
- **Quarantine from the smallest production change:** late set-based registry,
  HEAD avoidance and grouped-fact work until isolated benefit and combined worst
  failure-path resource evidence justify it. Preserve its associated tests and
  query-plan correction with the implementation.
- **Retain the test-environment correction:** 2 GiB full-stress temporary storage
  addresses an observed `SQLITE_FULL`; it is not an application memory result.

These are explicit promotion/simplification recommendations. All original hunks
remain physically preserved for review; none was silently accepted, discarded
or moved into the experimental format. Both unrelated plans have unchanged
SHA-256 hashes. This investigation adds reports and reproducible evidence only.

**#253 remains open.** Final selected-code validation, full manual hosted stress
and bounded workflow evidence remain outstanding. Historical 120-second failures
remain failures. #275's retained-history and 5/50 GiB capacity/accounting work is
also outstanding. See the [evidence index and reproduction instructions](evidence/publication-253-comparison-20260911/README.md).
