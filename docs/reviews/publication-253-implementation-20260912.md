# Publication testing changes after the reassessment

12 September 2026. Implementation follows the owner's instruction to make the
recommended changes. This records a new acceptance decision; the earlier
120-second failures remain failures. Issue #253 is not resolved by this record.

## What this fixes

The large publication test was trying to prove correctness, recovery and speed
under one deadline. Its local backup transport also assembled the entire SQL
export into a JavaScript value. A sufficiently large retained history failed in
that transport before a database could be restored.

The changes keep every original Product, related record, large field, integrity
assertion and real backup/restore check. They make the backup transport handle
large files and separate publication timing from completion. They also remove
unproven late optimizations from the working implementation. Publication still
uses the existing platform and public format.

## Acceptance decision

Only the Product-heavy journey in `reconciliation-scale.stress.spec.ts` changes
from a 120,000 ms test-body cap to 300,000 ms. Five minutes is a finite hang guard
with room beyond the previously incomplete 122–175-second hosted samples. It is
an engineering choice, not an application completion SLA or a claim that an old
run passed. Setup, teardown, callback resource limits and stress job caps remain
finite. No work moves outside the measured journey and no retry hides failures.

The Product test retains phase timings and its current phase in the JSON result,
with phase transitions in the log. Its four disjoint intervals are collection,
candidate preparation/inspection, publication including verified backup/restore,
and consumer verification. The earlier isolated comparison retains the finer
publication and backup phase measurements, request counts and retained-byte
censuses; these are emulator observations, not production billing.

The separate native candidate assertion remains **less than 15,000 ms**, with its
original workload and separate 120-second harness cap. Public components still
contain exactly one record; manifest pages still contain at most four
components. The grouped prototype remains an isolated experiment.

Acceptance still requires the complete intended full stress selection, a separate
native performance result, disposition of every failure, and full manual plus
bounded workflow evidence on the final code/runtime. Routine tests or a local
Product pass alone cannot close #253. The 5/50 GiB capacity work in #275 remains
separate.

## Backup transport

The test runtime owns a unique temporary storage directory. A small pinned patch
to `@cloudflare/vitest-plugin@1.1.6` preserves and forwards its configured
`resourcePersistencePath`; the plugin otherwise strips this global setting while
parsing Worker options. A wrapper around the public pool interface disposes the
runtime and its files together. No other runtime's temporary directory is scanned.
Remove the patch when the upstream pool exposes an equivalent owned persistence
path, after running the caller-retirement and transport regressions.

The provider mock uses [SQLite's native backup command](https://sqlite.org/backup.html) to obtain a consistent
snapshot, then emits a real [SQL dump](https://sqlite.org/cli.html#converting_an_entire_database_to_a_text_file) to a file. It streams that file through the
existing production download, backup-object and upload paths. The independent
restore database executes the uploaded SQL with the native parser, preserving
quoted text, UTF-8, triggers, indexes, blobs and search tables. A failed import
cannot replace the visible restore target. The SQL dump must have its completion
trailer: SQLite can emit an error/ROLLBACK while exiting with status zero.

The native SQLite command has a five-minute process cap. The owning tests and
workflows retain their own finite bounds. Both source snapshot and independent
restore are real database operations. The implementation requires the existing
`/usr/bin/sqlite3` command on macOS/Linux and uses disposable local files; it adds
no production service or infrastructure.

A first implementation using Node's asynchronous SQLite backup function was
rejected: repeated small backups took 30/8 seconds and a read-only dump of a
separately modified WAL snapshot returned incomplete SQL. The retained failure
logs distinguish these implementation failures from the successful native
snapshot/stream/import check.

## Existing working-tree disposition

The [hunk inventory](publication-253-diff-disposition-20260911.md) is the basis for
selection, not blanket approval of the original diff.

- Retain bounded repeated reads/writes, replay-safe batches, partition reuse,
  callback-local absence checks, 128-row backup scanning, native non-resumable
  hashes, four-object staging, public object/leaf batching, correctness fixes and
  recovery/resource regressions. Retain the demonstrated full-stress temporary
  storage correction. Individual constant increases with no isolated speed
  evidence remain described as unproven individually.
- Remove the private export exception of eleven units. Private preparation now
  uses the same maximum of six units, with the existing byte and phase stops.
- Quarantine set-based staging admission/completion, registry-based omission of
  object HEAD requests, and deferred multi-projection public-fact SQL. Restore
  the simpler per-object tickets and per-projection statements inside the same
  bounded transactions. Keep actual conditional-reuse accounting and all writes
  settling before a failure can propagate.
- Preserve previous reports, raw failed samples and experiment sources. The new
  evidence directory retains the starting patch and the exact simplification
  diff, so the quarantined work can be reconsidered without reconstructing it.
- Preserve the owner's two unrelated planning files byte for byte.

This does not make an unchanged publication cheap. The comparison found substantial
private preparation and backup work even when public files were all reused.
Before more tuning, establish publication frequency, whether consumers usually
fetch everything or only changed files, and an acceptable background window.
The modest grouped experiment reduced file count but did not demonstrate a
reliable publication-time benefit; it does not justify a public format change.

## Validation

The sequential retained-history validation completed all three acceptances and
restored/verified every checkpoint. It used the original 1,001-Product data and
verified the complete 4,006-record consumer catalogue after each acceptance.

| Acceptance            | Entire measured journey | Publication including backup/restore | Public files created / reused | Actual SQL backup bytes |
| --------------------- | ----------------------: | -----------------------------------: | ----------------------------: | ----------------------: |
| Full                  |                79.584 s |                             59.572 s |                     4,006 / 0 |             153,717,852 |
| Unchanged             |               127.869 s |                             70.054 s |                     0 / 4,006 |             394,507,625 |
| One Card name changed |               167.838 s |                            105.387 s |                 2,002 / 2,004 |             643,453,399 |

The complete test took 378.622 seconds under its explicitly separate 900-second
three-publication bound. Per-acceptance timings exclude the observer's subsequent
storage census; publication timing is nested inside the whole journey and must
not be added to it. Request/statement counters were not instrumented in this
validation. The earlier comparison remains the request-accounting evidence.
One changed Card also changes 2,001 lifecycle-only records, as in the earlier
comparison; this is not 2,002 independent source edits.

The database size reported by the emulator after the third acceptance was
824,287,232 bytes. Three retained SQL backup objects occupied 1,191,678,876 bytes.
The third SQL file now crosses the former giant-string boundary and really
restores; the earlier failure is still retained as a failure of the old runtime.
This does not establish 5/50 GiB capacity or production speed/billing.

A smaller direct boundary reproduction seeds 260 rows of 1 MiB each. On the same
data the old Miniflare export fails with `Invalid string length`; the replacement
exports 545,269,208 SQL bytes in 1.367 seconds, streams the upload in 1.025 seconds,
and imports into SQLite in 1.548 seconds. Every row's exact content and length
survives, including after a subsequent live-source change.

Five small transport/parser/failed-upload regressions pass. The preparation,
staging/cleanup and callback-resource selections pass (53 tests), and the corrected
shared transport passes all five caller-retirement tests. The earlier caller
failure with the incomplete persistence-path patch remains in the evidence.

Complete local validation passed: frozen installation, all non-test checks,
1,559 routine tests (307 domain, 95 API, 794 ingestion and 363 acceptance), and
all 20 tests across the ten-file full stress selection. Heavy local runs were
sequential. No production tuning was added after these results.

Hosted validation used the exact code/test/configuration snapshot
`8a48b5f95e476432fcdd45c1dc6b3d2d272f67e4` on
`codex/publication-253-validation-20260912`:

| Run                                                                                                                         | Result                                                              |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Focused shared transport/preparation/resource checks](https://github.com/KeeprDigital/card-keepr/actions/runs/34675388868) | 33 tests passed                                                     |
| [Full CI](https://github.com/KeeprDigital/card-keepr/actions/runs/34675532753)                                              | All nine jobs passed, including all ingestion and acceptance shards |
| [Bounded manual selection](https://github.com/KeeprDigital/card-keepr/actions/runs/34675535411)                             | Both tests passed                                                   |
| [Full manual selection](https://github.com/KeeprDigital/card-keepr/actions/runs/34675534158)                                | All 20 tests across ten files passed                                |

The original Product journey measured 78.015 seconds locally and 110.850 seconds
hosted, including 61.663/79.993 seconds for publication with verified backup and
restore. These measurements are under the new five-minute hang cap. They do not
retrospectively validate earlier code under the old two-minute acceptance.

The separate native preparation measured **7,736 ms locally and 14,277 ms
hosted**, against the unchanged less-than-15,000 ms assertion. Both runs observed
at most 41 instrumented calls in a callback. The hosted timing leaves only 723 ms
of margin: one pass does not establish a stable performance margin. Keep any
future failure visible and review the performance requirement separately from
publication correctness; do not compensate by changing the Product deadline.

Local validation used Node 26.8.2, pnpm 12.3.4, Vitest 4.1.11 and the pinned
Cloudflare plugin 1.1.6 on macOS. Hosted runs used the same project toolchain on
Ubuntu 24.04.5 (runner image `20260907.300.1`). These are emulator results, not
production CPU, memory limits, maximum throughput or billing measurements.

The `stress` command name remains for compatibility. Its twenty cases mix large
workloads, recovery, configured-limit enforcement and performance assertions.
For example, publishing/restoring 1,001 Products proves completeness at that
volume; rejecting one request beyond an adapter limit proves admission control.
Neither finds the machine's breaking point. A deliberate overload experiment
would also specify increasing load or constrained resources and expected failure
and recovery. Uncontrolled hardware makes timing comparisons harder, while the
integrity and recovery assertions remain meaningful.

The [evidence index](evidence/publication-253-fixes-20260912/README.md) retains raw
results, all failed attempts, source patches and a SHA-256 manifest. The isolated
hosted snapshot contains the 53 changed code/test/configuration files; each was
compared byte for byte with the final working copy. Reports and raw evidence
remain local. The owner's working tree remains uncommitted on its original
`main` commit, and both unrelated planning files retain their starting hashes.

## Recommendation and issue status

Keep the streamed test backup transport, separate completion/timing acceptance,
and selected simplification. Keep the public format and existing platform.
Review and merge this bounded change before further production tuning. A later
efficiency decision should start with the repeated private work and retained
backups on an unchanged publication, using an agreed publication frequency,
download pattern and background completion window.

The implementation and specified validation are complete. This record does not
close #253, change its GitHub acceptance text or claim that production efficiency
is solved. Review/merge and explicit reconciliation of the issue's historical
acceptance remain outstanding. The 5/50 GiB usable-capacity claim in #275 remains
unproven by these tests.
