# Reference-safe cleanup of unused terminal evidence

The owner starts cleanup for one terminal Ingestion Run or one failed/abandoned
Reconciliation Operation. Eligibility defaults to 30 days after its terminal
clock; `--retention-days` records a different positive whole-day policy on that
exact immutable intent. It does not change Catalogue Export deletion or the
newest-indefinite / dated-90-day Backup Retention policy.

```sh
keepr evidence-cleanup start --run-id RUN --idempotency-key KEY --json
keepr staging-cleanup start --preparation-id PREPARATION --idempotency-key KEY --json
keepr evidence-cleanup status --cleanup-id CLEANUP --json
keepr evidence-cleanup objects --cleanup-id CLEANUP --json
keepr evidence-cleanup retry --cleanup-id CLEANUP --expected-generation 0 --json
```

The first request persists intent before dispatching the existing Reconciliation
Workflow. Shards perform sixteen bounded units and dispatch deterministic
successors. Capture units visit at most eight physical keys; staging units visit
at most four. They read metadata and delete individual keys, never buffer object
bodies, enumerate a bucket prefix, or recursively garbage-collect a Merkle tree.
The protected owner API also offers one bounded `/advance` for operational
recovery; ordinary CLI operation does not run a deletion loop. Retry retains the
same intent and results, advancing the dispatch generation. Object result pages
contain at most fifty entries; pass their last `object_key` as `--after`.

## Physical ownership and references

Capture inventory consists of recorded capture and parse object keys in the exact
`EVIDENCE_OBJECTS` binding. Audit records, source identities, fetch attempts and
owner decisions remain. All snapshots belonging to retained candidates are
protected, including zero-observation pages and images. Cross-run snapshot
revalidation, native evidence selections, source mappings, identity reviews,
proposals, historical publication evidence and permanent decision references
protect their physical bytes. An old capture's age does not make a younger or
paused run's shared bytes eligible.

Preparation inventory consists only of pre-write registrations in the exact
`PRINTING_IMAGES` or `CATALOGUE_EXPORTS` binding. Failed/abandoned work without an
attached artifact can be reclaimed. Candidate image partitions, retained
artifact/node receipts, verified roots, export components and package manifests
protect their shared data. Existing pre-migration objects without positive
ownership inventory are not guessed from an R2 listing. The migration dates
previously terminal preparations conservatively from their existing deadline;
new terminal transitions retain their actual terminal clock.

A durable logical reservation atomically rechecks references and rejects new
reference holders. Physical deletion rechecks immediately before storage I/O.
A reference acquired before reservation wins and is retained; a later acquisition
fails closed. `evidence_object_references` is a permanent, immutable physical-key
pin for an explicit decision or recovery record. Use
`retainEvidenceObjectReferenceStatement` in the same D1 batch as that record;
free-text citations alone are not structured references. Temporary collection
and candidate references use their existing guarded tables instead.

## Backup boundary

Logical reservation makes reclaimed evidence unavailable for new use immediately;
content requests return `410 evidence_reclaimed` while the audit identity remains.
Physical deletion waits while any retained pre-reservation backup could restore
an unfenced source identity. New verified snapshots include reservations and
cleanup progress. After ordinary retention rotation expires the older backup
references, cleanup can delete unused bytes even with a normal published
catalogue and a newest verified backup present. It never deletes or shortens
retention of a backup to force progress. Restoring an older expired checkpoint
whose bytes have been reclaimed is rejected; restoring a post-reservation
checkpoint preserves the unavailable state.

Cleanup metadata participates in snapshot verification and actual recovery write
fences. An in-flight physical deletion prevents snapshot/recovery admission;
reserved keys waiting on backup retention do not prevent a new checkpoint.

## Interrupted writers and deletion outcomes

Capture/parse writes register before R2 I/O. Multipart upload IDs are retained
before completion. Cleanup can conclusively abort the exact upload, or recognize
a completed put by its exact writer token; it does not infer settlement from a
lease timeout. An unsettled key remains deferred while unrelated keys progress.

Shared staging writes and deletes have non-expiring tickets and a physical-key
incarnation. A successful delete settles only its own ticket. Once **all** delete
tickets have conclusively settled, a fresh preparation may reuse the same bytes
at the unchanged key by atomically advancing its incarnation. Old deletion
callbacks cannot acquire authority for that new incarnation. An ambiguous
storage response or lost execution remains inspectable and blocks reuse of only
that key; a timer, HEAD absence or another successful deletion is not proof that
an older deletion has settled. Do not clear tickets manually based on those
observations.

`paused` status and per-key results distinguish unsettled writers/deleters,
retained backup waits, and retryable capture deletion storage failures. A captured
source key is never resurrected by retry. Guarded Catalogue Export deletion
continues to use its separate immutable expiring plan, exclusive package manifest
scope, and retained shared component/recovery references.

The local tests use explicitly synthetic fixtures and injected failures. The
native recovery test imports an actual SQLite snapshot and checks reclaimed
content denial after acceptance. Neither proves live cleanup, complete-game
capacity, CPU/memory cost or an SLA.

Recovery admission also waits for unresolved source and staging writers. An
older snapshot must not erase a ticket for a storage call that may still finish.
This check belongs to original recovery reservation; rehydration preserves the
chosen snapshot's conservative ticket state. A rejected storage response or an
absent HEAD never clears that writer.
