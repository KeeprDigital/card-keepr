# Publish an exact game candidate

Inspect the sealed candidate and retain its candidate ID, manifest digest,
expected Game Catalogue Revision and generation. Approval covers the complete
candidate. Start publication with the owner CLI:

```sh
keepr publication approve --candidate-id CANDIDATE \
  --manifest-digest SHA256 --expected-game-revision-id GAME_REVISION \
  --generation GENERATION --idempotency-key INTENT --json
keepr publication status --operation-id PUBLICATION --json
```

The authenticated start persists approval before returning 202. The operation ID
is distinct from the candidate, reconciliation and source collection IDs.
Repeating the exact approval key returns its original acknowledgement; inspect
status for current progress. Reusing the key with different intent fails.

Verified artifact preparation and exact candidate readiness are independent
prerequisites. The Workflow waits for artifacts and the current composition's
verified backup checkpoint. Other games can prepare candidates and approve
publication while that checkpoint is pending. The original candidate deadline
remains binding throughout waits, retries and resume.

The final D1 transaction verifies the exact candidate approval, manifest,
predecessor, generation, deadline, recovery health and composition. It advances
the game and global heads, retains query visibility, records the publication
result, binds the candidate to its actual global revision, and reserves its backup together. A failed predicate rolls back the whole
transaction. Unrelated-game contention refreshes at most four immutable game
references with a bounded retry allowance. A stale same-game approval fails.

Resume a paused operation using its current operation generation and a new key:

```sh
keepr publication resume --operation-id PUBLICATION \
  --generation GENERATION --idempotency-key RESUME_INTENT --json
```

Resume preserves the candidate, manifest and deadline and increments the writer
generation. An old writer cannot commit. Publication consults no correction applicability
date; a correction becomes visible only through its approved candidate. Replaying the resume key retains its
original result and re-dispatches the current operation if work remains.

Ordinary reads select immutable game projections through the published
composition. Pagination pins that composition and rejects a conflicting explicit
revision. Image content links pin the same revision. Consumer export indexes
page four immutable per-record gzip NDJSON components at a time under the current
`card-keepr-catalogue-export-manifest@5` contract. Each component contains one
normalized public record; text and projection digests are verified before rendering.
Component descriptors and cursor are hashed with the manifest digest zeroed.
Host-specific download links live outside that hashed document. Export listing
records identify the composition content digest; follow the detail link for the
first manifest page and its digest. Exports remain available independently of
query-projection archival; retain their immutable facts, text and candidate bindings.
Private preparation roots are not consumer exports. Legacy public export shapes
are unavailable; retained historical recovery objects use a private validator.

Preparation carries first-observed, last-observed and lifecycle transition facts
against candidate identities. The fixed-size switch binds the newly published
candidate to the actual operation-derived global revision. Resolving those
immutable bindings preserves history across repeated source collections and
unrelated-game publication without prebinding a future global composition.

A retained legacy catalogue without prepared composition members cannot switch
natively: the database fails closed with
`publication_legacy_composition_unprepared`. Retaining legacy rows through the
schema migration does not establish verified native carry-forward roots. Do not
bypass this guard or fabricate a source collection to migrate such a catalogue.
[ADR 0008](../adr/0008-no-version-retention-before-go-live.md) requires old-shape data to be
regenerated before Go-Live. The supported native start is the empty catalogue
spine with freshly sealed candidates; an existing legacy current head requires
the separately controlled re-baseline/regeneration process before native
publication. The supported handoff and proof belong to
[issue 239](https://github.com/KeeprDigital/card-keepr/issues/239), with rollout
and freeze tracked in 151 and 136. This operation does not delete retained source evidence or perform
a database reset.

Issue 228 and composed backup/recovery issue 229 share a merge checkpoint. This
publication implementation alone is not launch-ready. Require the shipped owner
Workflow's backup and independently restored composed catalogue proof before
merging the joint work. Local integration tests are the gate; report actual CI
status separately.

## Recovery handoff

Schema 22 keeps the existing `catalogue_revisions` ancestry spine but removes
collection uniqueness for native publications. `publication_operation_id` is its
native authority; `ingestion_run_id` remains the real source collection. Legacy
rows have a null operation ID and retain the existing collection guard recipe
and partial unique index. A native operation never invents or publishes a source
collection identity. Candidate/preparation/source/publication IDs are distinct.

The same switch reserves an existing `catalogue_backup_attempts` row in `pending`
with `publication_operation_id`, real `publication_ingestion_run_id`, and exact
`catalogue_revision_id`. `request_json` binds the operation, revision and
composition digest. Actual backup/restore and verification are #229's work.

The shared repository interfaces are `publicationBackupReservationStatement(db,
attemptId)` and `publishedCompositionStatement(db, revisionId)`. The first returns
exact operation/candidate/preparation/source/revision/manifest/deadline bindings;
the second returns at most four game revisions, candidate IDs and verified root
digests. Root objects are `publication-artifacts/DIGEST` and recursively reference
#227 immutable artifacts. The preparation manifest includes inspection partitions;
consumer artifact components exclude administrative partition kinds.

#229 completes its existing immutable backup attempt/retry machinery. Publication
observes a verified attempt for the exact current revision, requiring a bookmark
and manifest digest. A retry child must retain the native operation/composition
bindings. No owner-supplied boolean clears the checkpoint. Pending verification
does not set recovery health degraded: other games can prepare and approve.
Actual recovery must set the global recovery health/active ID/restore guard and
preserve those fences until verified owner acceptance.

## Migration evidence

All inbound catalogue revision foreign keys use NO ACTION, with no DROP cascade.
The schema migration copies revision metadata, rebuilds the anchor without the
collection-wide unique constraint, then reinserts into the final table name so
SQLite's deferred foreign-key accounting closes. A populated migration test
preserves three legacy ancestors, exports, queryability, card references, backup
attempts and the current pointer, compares inbound foreign keys, and requires an
empty foreign-key check. Empty-database success alone is not this proof.
