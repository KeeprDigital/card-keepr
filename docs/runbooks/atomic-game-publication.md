# Atomic game publication

Implementation checkpoint for #228/#229; this branch is not launch-ready until
publication and composed recovery pass their joint checkpoint.

The owner approves the entire sealed candidate with its exact manifest,
expected Game Catalogue Revision and candidate generation. `POST /v1/publications`
persists that approval before returning 202; `/v1/publications/start` additionally
dispatches the durable Workflow. `keepr publication approve` uses the latter.
`GET /v1/publications/ID` / `keepr publication status --operation-id ID` reads
current status. Exact approval replay returns its retained acknowledgement,
including after completion; status is a separate read. The original candidate
deadline does not change. No correction applicability date is consulted.

The small switch transaction has eleven fixed statements. It inserts at most
four game references and constant-size revision, queryability, result and backup
metadata; it never inserts catalogue entities. Database guards bind the owner
approval, inspection receipt, verified preparation, slot, candidate and operation
generations, game predecessor, current composition, exact replacement members,
original deadline, recovery state and prior verified backup. Any guard error
rolls back every sibling statement. Unrelated-game contention refreshes only the
four composition references. Current plus two predecessor compositions remain
queryable; archived projections retain their immutable private evidence.

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
