# Issue 231: retained One Piece verification

The complete declared P-001 journey passed on 2026-09-08 (Australia/Melbourne).
The tested working-tree code was committed unchanged as `bc3a739` after the run
started. A later commit, `94fa729`, adds explicit API link/image-membership and
restored WINNER image-byte assertions; those additional assertions were not part
of this run and remain for final acceptance validation.

The command was:

```sh
KEEPR_P001_METRICS_PATH=/tmp/issue231-metrics.json \
  node --test acceptance/one-piece-two-source.test.mjs
```

The single test passed in 589.0 seconds. It overlapped the Riftbound task's native
intake on the shared host. Owner calls and polling were paced at 2.2 seconds to
preserve the normal 30-per-minute administration limit. **These elapsed-time,
CPU and memory observations are not capacity evidence.** No configured limit is
substituted for a measurement. See the [raw measured report](issue-231-one-piece-measurements.json).

## Functional evidence

The replay verified the immutable evidence-pack hashes before collection and
retained original response metadata. It simulated external HTTP delivery and the
Cloudflare control plane, while running shipped source parsing, Workflows, owner
CLI operations, publication, actual SQLite export/import, and consumer reads.
Request timestamps describe local replay, not fresh live-source checks.

The journey completed:

- All declared Bandai P-001 catalogue records, separate official event/Trophy
  corroboration, and all Limitless P-001 variants and their images.
- Explicit owner admission of the seven Bandai appearances and the distinct
  Limitless WINNER appearance, with a current-native-Card lookup and absent-target
  rejection. Seven reviewed cross-source pairs were linked to stable Printing IDs.
- Five exact candidate approvals and verified backup checkpoints: base Printing,
  eight appearances, linked source pairs, official-only refresh, and optional
  Limitless outage. All refreshes preserved the eight IDs. The optional source
  reported incomplete coverage with no successful-check or content-capture date.
- Separate synthetic missing-identifier and conflicting-known-fact responses
  failed closed. The published catalogue remained readable with the same IDs.
- Ordinary search, Card/Printing reads, all fifteen consumer image bytes against
  their SHA-256 values, and paged compressed exports. The WINNER Printing's
  unestablished printed text remained null. Private admission/source labels did
  not appear in the inspected public records.
- A new API boot using the actual verification-import database after runtime
  shutdown. Its Printing export matched the original exactly, and its ordinary
  WINNER Printing endpoint returned the same identity. Retained R2 objects were
  preserved through this local D1 restore.

No global Bandai absence or physical finish was inferred. The supplemental-only
claim is bounded to the seven-image Bandai catalogue capture; the separate
Bandai event publication corroborates the WINNER appearance.

## Census and amplification

| Measurement | Observed value |
| --- | ---: |
| Unique original HTTP responses | 26 |
| Original entity bytes | 3,690,112 |
| Original header bytes | 13,185 |
| Source catalogue records per complete two-source collection | 15 |
| Final accepted Printings | 8 |
| Final consumer Printing Images | 15 |
| Response deliveries across the journey, including injected faults/retries | 165 |
| Verified public export compressed bytes | 8,760 |
| Verified public export uncompressed bytes | 11,256 |
| Public export records / components, including catalogue metadata | 26 / 26 |
| Retained SQLite table rows across the complete local database | 9,482 |
| Allocated SQLite table pages, bytes | 12,812,288 |
| Allocated named SQLite index pages, bytes | 1,921,024 |
| Instrumented workflow step attempts | 3,877 |
| Instrumented D1 statement preparations | 94,984 |
| Instrumented D1 batch calls / submitted batch statements | 12,680 / 38,455 |
| Sum of instrumented workflow elapsed durations | 93,976 ms |

These are whole-journey values: eight collection attempts, five publications,
retained abandoned/failed work and initial database data. They are not the cost
of one ordinary refresh. Table/index allocation is 14,733,312 bytes, or 1,841,664
bytes per final Printing for this journey. There are 1,185.25 retained table rows
and 11,873 instrumented statement preparations per final Printing. Retained rows
are not a count of SQL writes; statement preparations and batch submissions are
separate counters and must not be added as independent executions.

The largest retained tables were reconciliation checkpoints (2,502 rows;
2,420,736 allocated bytes), reducer state (2,080 rows; 2,379,776 bytes), publication
preparation actions (750 rows; 1,536,000 bytes), and candidate partitions (183 rows;
868,352 bytes). The raw report includes every table and named index measured by
SQLite `dbstat`. This measures D1 footprint, not the separate R2 object store.

The Node test driver reported 59,065,645 user and 8,925,568 system CPU microseconds,
and maximum RSS of 614,992 KiB. These exclude workerd and CLI processes and must
not be described as isolate CPU or peak memory. The coordinated capacity campaign
owns those conclusions.
