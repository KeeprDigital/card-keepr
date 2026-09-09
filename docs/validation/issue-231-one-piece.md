# Issue 231: retained One Piece verification

The complete declared P-001 journey passed on 2026-09-08 (Australia/Melbourne)
at frozen commit `a46aeb8`. This run includes the seven-to-six in-scope
disappearance refresh, explicit consumer image-membership checks, and restored
WINNER image-byte verification. The measurements below replace the earlier
five-publication replay with this six-publication result.

The serial acceptance command was:

```sh
KEEPR_P001_METRICS_PATH=/tmp/issue231-final-metrics.json \
  node --test --test-concurrency=1 acceptance/*.test.mjs
```

The P-001 test passed in 703.0 seconds. Heavy runtime work was serialized under
the coordinator's shared-host slot; peer static work could overlap. Owner calls
and polling were paced at 2.2 seconds to preserve the normal 30-per-minute
administration limit. **These elapsed-time, CPU and memory observations are not
capacity evidence.** No configured limit is substituted for a measurement.
See the [raw measured report](issue-231-one-piece-measurements.json).

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
- Six exact candidate approvals and verified backup checkpoints: base Printing,
  eight appearances, linked source pairs, official-only refresh, seven-to-six
  Bandai scope refresh, and optional Limitless outage. The disappearance and
  outage are synthetic fault injections; the retained Bandai capture contains
  seven variants. All refreshes preserved
  the eight IDs. The scope refresh reported only the missing P-001_p6 Printing
  within the checked Card scope, without declaring the Card missing. The
  optional source reported incomplete coverage with no successful-check or content-capture date.
- Separate synthetic missing-identifier and conflicting-known-fact responses
  failed closed. The published catalogue remained readable with the same IDs.
- Ordinary search, Card/Printing reads, all fifteen consumer image bytes against
  their SHA-256 values, and paged compressed exports. The WINNER Printing's
  unestablished printed text remained null. Private admission/source labels did
  not appear in the inspected public records.
- A new API boot using the actual verification-import database after runtime
  shutdown. Its Printing export matched the original exactly, and its ordinary
  WINNER Printing endpoint returned the same identity and exact image bytes.
  Consumer links and image membership were also checked. Retained R2 objects were
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
| Response deliveries across the journey, including injected faults/retries | 174 |
| Verified public export compressed bytes | 8,770 |
| Verified public export uncompressed bytes | 11,256 |
| Public export records / components, including catalogue metadata | 26 / 26 |
| Retained SQLite table rows across the complete local database | 11,862 |
| Allocated SQLite table pages, bytes | 14,843,904 |
| Allocated named SQLite index pages, bytes | 2,752,512 |
| Instrumented workflow step attempts | 4,562 |
| Instrumented D1 statement preparations | 118,623 |
| Instrumented D1 batch calls / submitted batch statements | 15,322 / 46,694 |
| Sum of instrumented workflow elapsed durations | 122,806 ms |

These are whole-journey values: nine collection attempts, six publications,
retained abandoned/failed work and initial database data. They are not the cost
of one ordinary refresh. Table/index allocation is 17,596,416 bytes, or 2,199,552
bytes per final Printing for this journey. There are 1,482.75 retained table rows
and 14,827.875 instrumented statement preparations per final Printing. Retained rows
are not a count of SQL writes; statement preparations and batch submissions are
separate counters and must not be added as independent executions.

The largest retained tables were reconciliation checkpoints (2,921 rows;
2,805,760 allocated bytes), reducer state (2,445 rows; 2,785,280 bytes), publication
preparation actions (920 rows; 1,880,064 bytes), and candidate partitions (213 rows;
1,007,616 bytes). The raw report includes every table and named index measured by
SQLite `dbstat`. This measures D1 footprint, not the separate R2 object store.

The Node test driver reported 75,535,590 user and 11,579,138 system CPU microseconds,
and maximum RSS of 525,184 KiB. These exclude workerd and CLI processes and must
not be described as isolate CPU or peak memory. The coordinated capacity campaign
owns those conclusions.

## Integration and persisted-stage validation

Main `ea51172` was merged in `17e56d9`, including cleanup migration 0024.
Migration 0025 now requires schema 24; its populated SQLite regression preserves
three historical revisions and Card records, existing adapter registrations,
and foreign-key integrity while advancing to schema 25.

The local API suite passed 95 tests at `017d13f`. At that same head, the new
persisted-cursor regression correctly failed: SQLite rejected the standalone
`scoped_disappearance` phase under its checkpoint phase constraint. The fix
uses `scoped_printings` and `scoped_cards` stages within the existing
`disappearance_warnings` phase. Its interrupted-stage regression covers six
observed variants and a completely missing Card, retaining outside-scope records.
Both persisted cases passed at `ca14966` and again in the final affected-file run.

The full ingestion suite at `ca14966` passed 685 tests and failed ten. Five
failures exposed overly broad admission routing; a pinned adapter/coverage
Printing admission policy now confines mandatory owner review to declared scopes.
An owner-review scope accepts only an owner decision containing a Printing;
prior automatic and Card-only decisions remain history without authorizing a
new Printing. Five direct Worker regressions cover these distinctions.

Four normalization expectation failures reproduced exactly on unchanged main
`ea51172` (four failed, six passed). Its weighted image work budget already used
`1 + 2 * images`; expectations and the injected outage boundary now match that
budget while retaining total-record, no-reread continuation, and 100-call checks.
The remaining threshold test passed on unchanged main in 19.7 seconds with its
30-second deadline unchanged, and passed again on this branch.

All seven complete affected Worker files passed at `a46aeb8`: 101 tests. The
runtime-free domain suite passed 204 tests. Typechecking, changed-file lint,
import cycles and catalogue boundaries passed. Standards and Spec reviews found
no remaining actionable findings. The final serial acceptance run passed all
245 tests with none skipped in 1,468.4 seconds (24 minutes 28 seconds) at the
same frozen head.

Formatting passes for all 43 files changed from main. The generic `--changed`
formatter reports seven unchanged files, with the same seven failures reproduced
on unchanged `ea51172`; these inherited formatting issues were not modified.
