# Bounded source intake and one publication model

Status: **proposal pending user review**. Read-only architectural assessment for
#233 / #216 at `a24b9796`; no rewrite, ADR change, deployment or new experiment is
authorized by this document. This proposal supersedes further incremental memory
probing as the next decision. Historical failed measurements remain valid evidence.

## Diagnosis

Capture already streams raw bytes, and native reconciliation/publication already
have durable record-oriented processing. Between them, the source interface
requires complete document results, wraps them in another complete JSON document,
then reconciliation copies and parses that document again to recover records.
Discovery additionally assembles all retained records for a lineage. These are
architectural materialization requirements, not just an inefficient serializer.

The measured isolate failures were approximately 68–118 MB, not gigabytes of proven
live heap. Earlier gigabyte figures describe retained storage or cumulative work.
Nevertheless, working memory should depend on bounded pages/records and active
concurrency, not the total source or run size.

| Current interface / location | Materialization and actual bound |
| --- | --- |
| `SourceAdapterRegistration.parse`, `parseBytes`, `discoverRequests`, [registration types](../../src/catalogue/adapters/source-adapter-registration-types.ts#L48) | Whole document/byte input and complete output arrays. Raw limits are 16 MiB for Bandai catalogue, 2 MiB Riftbound, 1 MiB Limitless/One Piece errata. No output-byte budget in this interface. |
| [parseSnapshot](../../src/catalogue/source-evidence/source-evidence-parsing.ts#L91) | Raw buffer → decoded document → adapter array → wrapped array → canonical string → UTF-8 buffer at lines 91–148. Input size does not bound object overhead or expanded output. Parsing and discovery reread the same snapshot separately. |
| [retainedOfficialDiscoveryRunRecords](../../src/catalogue/source-evidence/source-evidence-parsing.ts#L342) and [capture caller](../../src/catalogue/source-evidence/source-evidence-capture.ts#L644) | Fully parse every retained discovery set and concatenate records; repeat after qualifying discovery/listing requests. O(total lineage discovery) working set, potentially repeated growing rescans. Request count limits are not a byte-memory budget. |
| [retainedPrintingImage](../../src/catalogue/reconciliation/reconciliation-evidence.ts#L602), [image validation](../../src/catalogue/reconciliation/reconciliation-observation.ts#L638), [candidate retention](../../src/catalogue/reconciliation/reconciliation-images.ts#L22) | Whole image bytes → binary string/base64 → decoded bytes for validation → decoded bytes again for storage. Up to three roles per observation; byte limit follows capturing adapter. Production normalization removes base64 before persistence. |
| [source document preparation](../../src/catalogue/reconciliation/reconciliation-source-document.ts#L105) | R2 observation JSON is copied into escaped D1 text chunks per preparation, then reparsed into source records. Reads are 64 KiB; checkpoints at four chunks/512,000 bytes. Parser limits include 4 MiB tokens, depth 128 and 16,384 structural tokens. Bounded reads still incur whole-document storage duplication. |
| [source observation storage](../../src/catalogue/reconciliation/reconciliation-source-observation.ts#L41), [text partitioning](../../src/catalogue/reconciliation/reconciliation-text.ts#L51), [input preparation](../../src/catalogue/reconciliation/reconciliation-input.ts#L126) | A record is serialized before splitting; large fields can be fully reconstructed later. Input preparation also JSON round-trips records. 512,000-byte batch thresholds and 32,768-character text chunks do not bound allocations made before chunking. This is per-record, not necessarily whole-run, materialization. |
| [old run approval route](../../src/catalogue/ingestion/routes.ts#L101), [publication lifecycle](../../src/catalogue/ingestion/publication-lifecycle.ts#L331), [export sorting](../../src/catalogue/export/export.ts#L216) | Still-routed whole-CatalogueCandidate path, component arrays/sorting and relationship `Promise.all` arrays. Export limits are 512 KiB/record, 12 MiB/component, 24 MiB total; these do not undo earlier allocations. |
| [native prior state](../../src/catalogue/reconciliation/native-prior-state.ts#L18), [native publication](../../src/catalogue/reconciliation/publication-preparation.ts#L92) | Existing record/partition/cursor processing to preserve. Native publication verifies image references and prepares bounded units. |
| [backup composition metadata](../../src/catalogue/backup-recovery/backup-recovery.ts#L1304) | Whole JSON parse is explicitly capped at 64 KiB. This is a legitimate bounded metadata operation, not a whole-database buffer. |

Two persisted inline-base64 copies are specifically a **legacy synthetic fixture
topology**: [capacity fixture](../../test/support/fake-publisher/reconciliation-documents.ts#L26)
embeds images in raw page JSON, and the fixture adapter passes them into retained
observation JSON. Decoded Printing Images form another copy. The 18.33/183.33 GiB
lower bounds describe that topology only. They are **not real-source baselines or
user hardware requirements for this redesign**. Current official adapters declare
image URLs; production does have transient base64 conversion and separate raw
capture/Printing Image blobs, but not those two persisted inline-base64 documents.

## Recommended replacement

Replace the intake interface; preserve the native reducers, canonical identity,
owner review and native publication implementation. A deep intake module should
own verified extraction, record-page writes, discovery admission and durable
progress behind this small conceptual interface:

```text
advanceExtraction(snapshotRef, adapterIdentity, cursor, workBudget)
  -> committedPageReceipt(nextCursor, recordCount, discoveryCount, completion)

readObservationRecords(observationSetRef, cursor, byteBudget)
  -> bounded records / large-field references + nextCursor
```

The caller receives receipts and cursors, never a whole lineage/run array. Adapter
extraction emits records and discovered requests through a budgeted sink that
awaits persistence. The module controls backpressure and commits output receipts
with progress. An async iterator alone is insufficient if an adapter builds its
entire array before yielding.

- **Raw evidence once:** retain one immutable body blob for each captured body;
  separate D1 snapshot provenance from physical blob location. Observations and
  images refer to its key, digest, length and source locator. Do not duplicate an
  image into JSON or a second permanent image blob solely for transport. Global
  cross-capture content deduplication is optional, not a prerequisite. Existing
  public image identities/URLs can resolve through verified references.
- **Bounded extraction:** JSON tokenization enforces record byte/depth limits
  before constructing large values where possible. Large accepted text/binary
  fields become bounded blob/text references, not silently truncated/rejected
  content. HTML parsers may materialize one explicitly capped page initially;
  page-size limits must reflect decoded/parser expansion, not raw bytes alone.
- **Record-manifest observation sets:** retain immutable ordered record pages
  once, with snapshot digest, exact adapter identity, stable ordinals, per-page
  digests, count and a completion/root digest. A set becomes usable only after
  final structural and coverage verification. A manifest is paged/indexed too;
  do not replace a giant record array with a giant array of references.
- **Incremental discovery:** insert deduplicated request/coverage facts into
  indexed D1 as pages arrive. Prove required surfaces, parent links, pagination
  termination and request capacity from persisted facts. Seal the immutable
  collection-plan identity after completeness; eliminate lineage flattening and
  repeatedly deriving a whole plan in memory.
- **Images:** stream captured bytes and digest verification. Read only bounded
  format headers for dimensions where supported; unsupported/oversized headers
  fail explicitly. Preserve artwork fingerprint and missing-image semantics.
  Reference-aware serving, cleanup and backup/restore must agree on blob roots
  before removing the existing second-bucket copy.

Target complexity: working memory O(active workers × (bounded parser page + bounded
record/batch + transport buffer)); persisted data O(raw bodies + derived records +
indexes + required history/exports). Runtime/platform overhead remains additional.
No unmeasured numeric memory guarantee is claimed. Sequential page count should
increase elapsed work/storage, not the maximum retained application working set.

## Migration and deletion

**Recommend intake-first replacement with a single pre-Go-Live contract.** First
vertical slice: Riftbound paged JSON plus a realistic synthetic fixture that emits
image URLs and serves separate streamed image responses. Exercise discovery,
extraction, sealed record manifest, existing native reconciliation and review,
publication, cleanup and restore. Second slice: HTML adapters with bounded page
parsing and the same record sink. Keep source authority/completeness policies in
adapters; move storage/progress mechanics out of them.

This is a finite migration, not a permanent compatibility layer. During development
old readers may exist only for callers still being migrated. Before rollout, switch
all current adapters/fixtures, regenerate affected pre-Go-Live derived data through
an explicit operator plan, and remove the old interface and readers together.
Do not delete retained raw evidence/history as a shortcut.

Delete or simplify when their last callers move:

- Whole observation-set JSON assembly/retention and the R2 JSON → D1 escaped text
  chunks → reparsed source-record path. Consume immutable record pages directly.
- `retainedOfficialDiscoveryRunRecords` flattening and full-array collection-plan
  construction; replace with indexed coverage/admission queries.
- Image base64 encode/decode transport and inline image fields. Remove duplicate
  candidate-image writes only after serving/GC/restore reference migration.
- JSON clone/restore helpers used solely to shuttle source records between these
  representations. Keep bounded text support genuinely required by reducers.

**Alternative: cohesive pre-Go-Live cutover.** Replace intake and retire the old
whole-run publication model in one regenerated contract/release. This removes
parallel models sooner but has a wider identity, CLI/API and recovery risk. It is
viable only after a supported-caller inventory and full vertical validation.

Native game publication is the target single model under ADR 0015. The old
`POST /v1/ingestion-runs/:run/approval` route is still live code: inventory CLI,
HTTP/API, test and operational consumers, intentionally migrate or remove them,
then delete the old whole-candidate lifecycle/export entry points. This is an
interface retirement, not dead-code cleanup. Do not silently route old requests
into different approval semantics.

## Contracts and proof before rollout

[ADR 0010](../adr/0010-retain-evidence-in-d1-and-private-r2.md) requires exact retained
bytes and provenance, not monolithic JSON/base64. [ADR 0015](../adr/0015-bounded-durable-publication-per-game.md)
requires bounded durable preparation and whole-candidate approval, not whole-
candidate RAM. The redesign fulfills both. [ADR 0012](../adr/0012-official-source-adapters-fail-closed.md)
requires incomplete evidence to fail closed. [ADR 0008](../adr/0008-no-version-retention-before-go-live.md)
permits one current definition and regeneration before Go-Live; it does not waive
retained-evidence, published-history or recovery obligations. This proposal changes
no accepted ADR and requires user review before implementation.

Tests should cross the replacement intake interface and establish:

- More pages at fixed page/batch/concurrency limits do not increase peak live
  application buffers; per-unit binding calls and bytes stay bounded. Test a
  slow sink for backpressure and an oversized record/header before construction.
- Missing pages, duplicate/conflicting ordinals, invalid UTF-8/digests, malformed
  structure and incomplete required surfaces never seal an authoritative empty
  set. Partial output remains resumable and unavailable to reconciliation.
- Raw body bytes/digests, source provenance, deterministic record ordering/IDs and
  semantic candidate/canonical digests match the current accepted fixtures.
  The new storage-manifest digest may differ by design; never call that a
  byte-identical old observation envelope.
- A crash before/after each page commit, lost response, concurrent retry and
  cleanup race reuse exact receipts/cursors and do not duplicate records or
  orphan/delete referenced blobs. Preserve exact writer ownership.
- Native identity decisions, owner review, predecessor binding, seven-day
  deadline and atomic publication remain unchanged. Actual backup/restore and
  image serving verify the same references, including shared-blob liveness.

Replace the full-tier fixture topology before estimating its new storage budget.
Account separately for raw blobs, record pages/indexes, versions, exports and
restore staging. Do not carry the old base64 multiplier into that estimate.
