# Three-publication experiment: local SQL export failure

11 September 2026. This is a retained failed experiment, not a timeout adjustment
or a successful three-publication recovery result. No production change is
proposed by this note.

The full → unchanged → changed sequence completed the first two publications,
including actual SQL export/import and disposable-restore verification. The third
publication switched and dispatched backup, but that backup failed during local
SQL export. It did not reach target preparation, SQL import or restored-content
verification. The helper correctly rejected `state: "failed"` when it required
`verified`; the complete experiment failed after approximately 400 seconds.
[Raw log](evidence/publication-253-comparison-20260911/single-three-revision-failure.log.gz),
[phase and inventory evidence](evidence/publication-253-comparison-20260911/single-three-revision-failure.json.gz).

| Accepted candidate in sequence | Consumer facts                                                      |      Retained SQL export bytes | Emulator database bytes after phase | Backup result                  |
| ------------------------------ | ------------------------------------------------------------------- | -----------------------------: | ----------------------------------: | ------------------------------ |
| Full                           | 4,006 records                                                       |                    162,475,614 |                         211,304,448 | Verified, restore generation 1 |
| Unchanged                      | Same 4,006 records and content digest; all public components reused |                    410,950,725 |                         509,718,528 | Verified, restore generation 1 |
| One changed source record      | Final consumer verification not reached                             | Unknown: export did not return |                         821,755,904 | Failed before restore          |

The second SQL size is the increase in the retained `catalogue-backups` inventory
between the first two completed phases. Database bytes are the reported local
D1 size, not SQL bytes or working memory. Reusing all consumer files did not stop
private/history/database growth: for example, retained query documents increased
from 4,006 to 8,012 to 12,018. This does not identify which tables dominate bytes;
the report contains row counts but no reliable per-table byte attribution.
[Recorded inventories](evidence/publication-253-comparison-20260911/single-three-revision-failure.json.gz).

The decisive error is Miniflare `RangeError: Invalid string length` in
`#doExportData`. Installed package `miniflare@5.20260908.0-alpha`,
`dist/src/workers/d1/database.worker.js`, implements that method by collecting
`Array.from(dumpSql(...))` and passing the complete result to `Response.json`.
The dump generator emits SQL row by row, but this caller materializes the entire
dump as an array before JSON serialization. The Worker test configuration then
retrieves that array with `raw()` and joins it into a single SQL string.
[Owning test transport](../../apps/ingestion/vitest.config.ts),
[failure stack](evidence/publication-253-comparison-20260911/single-three-revision-failure.log.gz).

This evidence localizes an observed failure to the emulator's whole-export
serialization path. It does not establish its exact byte threshold, prove an
out-of-memory cause, or establish a production V8, SQL or D1 database ceiling.
The production backup provider uses the Cloudflare polling export API and returns
the signed download's body stream, a different transport from this local pragma.
[Production export provider](../../src/catalogue/backup-recovery/backup-recovery.ts).

The smallest immediate response is to retain this failed history and complete
independent full → unchanged and full → changed pairs using fresh real D1/R2 for
each pair. Those preserve the original per-publication workload and actual
backup/restore checks and permit a fair packaging comparison at equal history
depth. They establish two-publication results only; they do not turn the failed
three-publication history into a pass or complete longer-history capacity proof.

The next bounded follow-up should isolate this export transport before more
publication tuning: reproduce the local serialization failure with a finite
database fixture, then evaluate an existing supported file-backed or streamed SQL
export/import seam while retaining every required table and schema object, the
exact snapshot boundary and independent restore assertion. No dropped history, skipped backup,
fabricated verification or raised production resource guard is justified.
Retain exact versions and measure dump bytes, database bytes and phase duration.
Separately account for retained database growth so a transport fix does not hide
the cost of repeated no-change publication.

Existing acceptance helpers are useful prior art but are not already a proven
fix: `nativeSqliteExport` streams `.dump` to disk, then reads the complete file as
UTF-8; its caller splits, filters and rejoins complete SQL strings and retains
snapshots in memory. Merely substituting that helper can move the same class of
large-string problem elsewhere. Review the entire local transport before adopting
it, then rerun the original failed history on the chosen seam. This is a proposed
test-provider follow-up, not a request to alter production backup.
[Native export helper](../../acceptance/helpers/native-sqlite-export.mjs),
[acceptance recovery transport](../../acceptance/helpers/native-recovery-cloudflare.mjs).
