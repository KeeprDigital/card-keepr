# Publication reassessment: requirements and cost model

Date: 11 September 2026. Read-only requirements research against the working
checkout at `fa0a404e4f980914a79825d6ff34f6d9f68e6a48`, which has substantial
uncommitted changes. This note does not validate that diff, change a production
contract, revise an issue, or claim a stress result. Issues were read directly
with GitHub CLI, including their comments; Cloudflare references were retrieved
on the report date. Measurements and change disposition belong in the companion
reassessment evidence.

## What the owner actually requires

The selected architecture is cost-conscious background publication on Workers,
Workflows, D1 and R2. Neither a monthly spending ceiling nor a publication
completion SLA was agreed. The approximately 8 MiB export-component size is an
adjustable engineering target. It is not a requirement to create 8 MiB objects,
nor a claim of measured capacity. These decisions are explicit in
[#214's accepted resolution](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899)
and [#216's capacity and operational proof](https://github.com/KeeprDigital/card-keepr/issues/216).

The requirements divide into five categories:

| Category          | Required behavior or current choice                                                                                                                                       | Consequence for reassessment                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness       | Complete immutable candidate for one game; exact whole-candidate approval, manifest and same-game predecessor; consistent composition-pinned reads and exports            | Grouping may change packaging, but cannot omit, duplicate, invent or silently alter facts                                                          |
| Recovery          | Verified objects and projections before a small guarded atomic switch; backup reservation in that switch; actual disposable restore before the next composition publishes | A prepared object, queued backup, or mocked success cannot substitute for completed restore and consumer checks                                    |
| Durable execution | Bounded work and memory, persisted cursor/results, exact idempotent replay, finite retries then inspectable pause, safe resume, old-writer fences                         | Larger groups must still bound one failed unit and must not commit receipts before verified storage                                                |
| Current format    | Exactly one public normalized record per gzip NDJSON component, at most four components per manifest page                                                                 | Multi-record groups deliberately change the public contract; preserving equivalent facts alone does not satisfy today's format assertion           |
| Test assumptions  | A 15,000 ms native-candidate performance assertion and a separate 120-second complete Product journey deadline                                                            | Neither is a publication SLA or Worker CPU limit; any revised acceptance must name the superseded test condition and retain the historical failure |

Correctness and recovery details come from [ADR 0015](../adr/0015-bounded-durable-publication-per-game.md),
[the domain vocabulary](../../CONTEXT.md),
[publication preparation](../runbooks/publication-preparation.md), and
[atomic publication](../runbooks/atomic-game-publication.md). They also require:

- The original seven-day candidate deadline survives approval, pauses, retries,
  and backup waits. Same-game changes require fresh reconciliation and approval;
  unrelated-game publication does not invalidate approval.
- Missing or corrupt required artifacts block readiness. Transient retries do
  not make corrupt evidence, stale approval, or expired candidates valid.
- Collection may proceed concurrently, while reconciliation/review/publication
  serialize per game. Other games may prepare and receive approval during backup
  verification; only their final switch waits.
- Full before/after inspection includes evidence-only changes. Consumer exports
  contain accepted facts and explicit unknowns, excluding administrative evidence.
- Cleanup preserves paused work, shared objects, retained history and recovery
  references, with fresh checks and writer fencing before deletion.

The backup distinction matters: a **Disposable Restore** proves a Backup Attempt;
**Catalogue Recovery** changes the production catalogue and needs global mutation
fencing through owner acceptance. Current plus two predecessor revisions retain
operational export/recovery evidence. This is separate from prelaunch schema
compatibility. [ADR 0010](../adr/0010-retain-evidence-in-d1-and-private-r2.md),
[ADR 0008](../adr/0008-no-version-retention-before-go-live.md).

## Packaging is a contract decision

The public schema enforces `components.maxItems = 4` and `records.const = 1` in
[the manifest schema](../../contracts/schemas/catalogue-export-manifest-v5.schema.json).
[The exporter](../../src/catalogue/ingestion/publication-export-preparation.ts)
creates `records: 1` descriptors, and the Product stress test checks that every
component contains one record and at least 3,003 stored components exist for
1,001 Products and their Releases and Distribution Contexts.
[Original test](../../apps/ingestion/test/reconciliation-scale.stress.spec.ts).

Private preparation components are also documented as at most one record and
512 KiB. They are a separate internal envelope, not the public compressed export.
Reducing public file count alone does not remove private projection, identity,
evidence, text, or backup work. Report both layers independently.
[Preparation runbook](../runbooks/publication-preparation.md).

Before Go-Live, an approved contract change edits the existing schema in place
and regenerates earlier-shape data; no new schema major or compatibility reader
is required. It must still update the producer, consumer validation, documented
format, test assertions, deletion/recovery assumptions and exact regeneration
procedure together. This is permission to evolve deliberately, not permission to
silently accept a different format. [ADR 0008](../adr/0008-no-version-retention-before-go-live.md).

An isolated grouped experiment should retain every record-level oracle and
explicitly mark the original one-record/component and minimum-file assertions
as intentionally inapplicable to that experimental format. Compare normalized
record sets, stable identities, relationships, bytes/digests, pagination closure,
consumer reads, and restored content. Do not call the grouped run a pass of the
unchanged public-format test.

Stable groups should depend on persistent record identity or stable key ranges,
not merely the ordinal position in the complete sorted catalogue. For example,
an inserted Product near the start of a list should affect its own group and
bounded overflow, rather than shift every later group. A byte ceiling and record
ceiling must both hold; one unusually large record still needs the existing
large-record treatment. This is a design criterion for the comparison, not a
claim that the current implementation supports stable groups.

## Platform limits versus engineering guards

These are current documented **Paid-plan** limits, not proof of this account's
configuration or production performance:

| Platform boundary | Documented limit relevant here                                                                                                                                          | Repository distinction                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Worker isolate    | 128 MB memory across the isolate, including concurrent requests; six simultaneous outgoing connections                                                                  | The 64 MiB working-set target and four-open-body guard leave deliberate headroom                                                 |
| Workflow step     | 30 seconds active CPU by default, configurable to five minutes; unlimited platform wall time; 1 MiB non-stream step result                                              | `apps/ingestion/wrangler.jsonc` explicitly configures 10,000 ms CPU; the complete background operation spans steps               |
| Workflow instance | Default 10,000 steps, configurable to 25,000; default 10,000 subrequests, configurable higher                                                                           | The repository configures 5,000 subrequests and uses smaller durable successor shards; a 100-call callback guard is local policy |
| D1                | 10 GB database; 2,000,000-byte string/BLOB/row; 100 query parameters; 100,000-byte SQL statement; 30-second query/batch limit; 1,000 queries per Paid Worker invocation | The 5 GB topology-review trigger, 1 MiB staging target, and small final transaction are more conservative engineering limits     |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/),
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[current ingestion configuration](../../apps/ingestion/wrangler.jsonc),
[#214 budgets](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899).
The Cloudflare Workflows limits page contains inconsistent ancillary concurrency
and script-size prose; those unrelated figures are not used here.

The accepted initial choices also include metadata partitions of at most 1 MiB
and 500 records, at most 100 staging mutations, a final transaction of at most
20 statements/64 KiB, under-one-second p95 D1 targets with a five-second
operational ceiling, and under-two-second p95 start/status targets within the
ten-second CLI deadline. Current preparation uses a stricter 512 KiB metadata
ceiling. These numbers are adjustable with recorded evidence; boundedness and
the approval/recovery guarantees remain required.
[#214](https://github.com/KeeprDigital/card-keepr/issues/214#issuecomment-5558801899),
[preparation runbook](../runbooks/publication-preparation.md).

## What counts as cost evidence

Current official pricing distinguishes these dimensions:

| Service     | Relevant billing dimensions and listed Paid rates                                                                                                                                                                           | Measurement implication                                                                                                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workflows   | CPU, instance invocations, steps and retained state; 500,000 steps/month included, then $0.80/100,000; 1 GB-month state included, then $0.20/GB-month                                                                       | A callback is not necessarily one billed step, and steps within an instance are not separate invocations. Step/storage billing began 10 August 2026. Retried callbacks are not directly billable-step counts |
| D1          | Rows read/scanned, rows/index entries written, and database/index storage; 25 billion reads and 50 million writes/month included, then $0.001/million reads and $1/million writes; first 5 GB included, then $0.75/GB-month | Combining several queries into one binding call can reduce latency without reducing row work; retained projections and indexes affect backup/storage cost                                                    |
| R2 Standard | $0.015/GB-month, $4.50/million Class A operations, $0.36/million Class B operations; 10 GB-month, 1 million A, and 10 million B included monthly; no egress charge                                                          | PUT/list are A; GET/HEAD are B. Count verification and backup reads as well as publication writes. Retained bytes over time matter                                                                           |

Sources: [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).
These are published rates and allowances, not a bill estimate. Account-wide
allowance use, provider rounding, storage duration, production CPU and actual
provider operation accounting remain unknown.

The approximately 2,007 private preparation callbacks and 1,265 public export
callbacks supplied for this investigation are instrumented work counts. They
cannot be multiplied by a single price to establish monthly cost. Elapsed time
includes waiting and emulator overhead; it is not CPU. A local database result's
available row metadata is useful but must be labelled emulator metadata, with
missing metadata reported rather than invented. Host-process RSS includes the
test runner/emulator and does not establish continuous isolate peak memory.

For a usable comparison, report disjoint phase elapsed time; created/reused
objects; GET/HEAD/PUT/list requests; D1 calls, statements and available row work;
retained bytes by object class and database; SQL export/import and independent
restore verification work; and repeated work after a precise interruption.
Compare full downloads with changed-object downloads. Keep the original complete
catalogue and actual restore in both approaches. This follows
[#275's accounting acceptance](https://github.com/KeeprDigital/card-keepr/issues/275).

## Test acceptance and unresolved decisions

The native candidate test starts its measured interval after collection and
candidate admission, then measures reconciliation callbacks to sealing. It
asserts less than **15,000 ms** and at most 100 method entries per callback; the
test itself has a separate 120-second harness deadline. The Product-heavy
publication test covers collection, candidate work, approval, actual backup and
restore through its helper, export records and stored digest checks under another
**120-second** harness deadline. These are separate observations.
[Candidate test](../../apps/ingestion/test/game-reconciliation-scale.stress.spec.ts),
[Product journey](../../apps/ingestion/test/reconciliation-scale.stress.spec.ts),
[#253](https://github.com/KeeprDigital/card-keepr/issues/253).

Proposed acceptance should preserve the original 1,001-Product workload,
associated records, all substantive integrity/recovery/consumer checks, finite
per-phase hang detection and a finite outer cap. Measure phase time and work as
results rather than treating the old end-to-end cap as a product promise. A
revised cap is a newly documented test acceptance decision, with historical
120-second failures retained as failures under their original conditions.
The 15,000 ms assertion retains its separate status until explicitly assessed;
moving or changing the large journey's hang timeout cannot satisfy it.
[Testing policy](../testing.md), [testing reassessment](../testing-reassessment.md).

No evidence here establishes publication frequency, consumer full-download versus
incremental-download frequency, an acceptable background completion window, or a
monthly cost ceiling. Those remain requirements to derive or decide using the
comparison. For infrequent publication, thousands of cheap storage operations
may cost less than maintaining a complex grouping/recovery protocol; frequent
full downloads can make fewer files valuable even when publication itself is
acceptable. This is a conditional tradeoff, not a measured result.

#253 remains open for the full current selection and its final hosted/manual and
bounded verification evidence. A routine CI pass, isolated diagnostic success,
format experiment, or changed timeout does not satisfy that recorded acceptance.
#275 separately owns the accepted 5/50 GiB workloads, real-source completeness,
peak memory and full resource accounting; a small pilot or successful capacity
guard cannot certify them. Existing topology should remain until a concrete
bottleneck or coordination simplification justifies adding infrastructure.
[#253](https://github.com/KeeprDigital/card-keepr/issues/253),
[#275](https://github.com/KeeprDigital/card-keepr/issues/275),
[ADR 0015](../adr/0015-bounded-durable-publication-per-game.md).
