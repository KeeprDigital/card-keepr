# Catalogue implementation

Use [domain language](../../CONTEXT.md) and [architecture](../../docs/architecture.md)
for meaning and decisions. Each cluster exposes an explicit `index.ts`; internal
modules are implementation details. The import gate counts type imports too.

## Ownership and imports

| Cluster           | Owns                                                                                   | May import                                         |
| ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `shared`          | Canonical serialization, domain types, CatalogueStore, workflow and storage primitives | No other cluster                                   |
| `adapters`        | Source registrations, acquisition surfaces and pure parsers                            | `shared`                                           |
| `read`            | Published consumer projections, filtering, pagination and HTTP representations         | `shared`, `adapters`                               |
| `curated`         | Curated Revision validation, immutable lifecycle and pinned selection                  | `shared`                                           |
| `source-evidence` | Collection, retained bytes, authority, intake, collection recovery and cleanup         | `shared`, `adapters`, `curated`                    |
| `reconciliation`  | Canonical identity, per-game preparation, inspection, artifacts and native publication | `shared`, `adapters`, `curated`, `source-evidence` |
| `export`          | Export validation and guarded package deletion                                         | `shared`, `reconciliation`                         |
| `backup-recovery` | Backup dispatch, SQL export/restore and verified recovery                              | `shared`, `read`                                   |
| `ingestion`       | Administration composition, release guards and retained historical operations          | Every cluster                                      |

Cross-cluster imports target the owning index; indexes enumerate exports from their
actual defining modules. The API Worker imports only `read`, `shared`, `src/http`
and runtime capabilities. `src/http` is a leaf and imports no catalogue code.
Tests and tools may import internals. `pnpm run check:imports` enforces boundaries
and detects cycles; its `allowedImports` table is the executable dependency rule.

## Persistence and transitions

Domain functions choose reads, execute writes and compose transactions.
Repository factories prepare and bind named SQL statements without executing
queries or making domain decisions. The branded CatalogueStore exposes atomic
execution; only repositories obtain statement-preparation capability.

`atomicRepositoryStatement` binds a primary mutation to its authority/state
guards and effects. CatalogueStore expands recipes into one native D1 batch,
returns primary results in order and rejects oversized batches before writing.
A failed guard rolls back sibling writes. Callers still check affected-row counts.
Dynamic table choices stay inside the repository.

Ingestion Run identity remains immutable. Current state is a projection of
append-only run events; accepted CAS transitions update both atomically. Rejected
writes append nothing. State-authorized effects verify the projection against its
latest event. Projection rebuild requires release/recovery maintenance authority,
validates history and payloads, and does not replay external effects. State-table
changes must keep the database transition guard and parity test aligned.

## Adapters and reconciliation

Adapters parse retained bytes and discover requests without I/O. Transport
permission does not designate fact authority. Production registrations live in
`adapters/source-adapters.ts`; synthetic adapters are explicitly composed under
`test/support`. Classify expected source-contract rejection separately from
configuration/programming failures. Retained-byte tests verify representative
outputs; their golden matrix has no automatic update path.

Source collection IDs identify provenance. Preparation IDs own checkpoints,
input/record/text partitions, pinned decision cutoffs and staging mappings;
candidates own game partitions. Published visibility follows candidate publication,
never the collection's state. Empty pinned decision selections are meaningful:
later owner decisions cannot leak into an existing preparation through a fallback.

Workflow history carries bounded references. D1 records generation/shard budgets
before attempts; lost results and restarts cannot replenish them. Successor IDs
are deterministic. Pause/resume uses owner generation transitions and preserves
the original deadline. Use `shared/workflow-driver.ts` for binding control calls;
reconcile ambiguous dispatch against the exact retained instance.

Storage-error wrappers take `() => Promise<T>`. Construct and bind statements
inside that callback so synchronous failures are classified too. Digest, ordinal,
receipt and capacity validation stay outside it; semantic errors must not become
transient storage failures. Large text is separately chunked and digest-verified;
metadata caches never retain hydrated unbounded content.

## Published reads

Read models consume published composition/projections. Cursors bind revision and
normalized filters; unavailable first-page projections return 503, stale pinned
cursors return 409 with an absolute restart link. Validate filters before
conditional responses. Keep ETags canonical and stored content independent of the
public host. Query builders use indexed facts rather than parsing stored JSON.
Public export reads serve verified immutable bytes and remain independent of
query-projection archival.

## Backup and cleanup

Publication reserves its backup and dispatch identity atomically with the new
revision. Dispatch acknowledgement is distinct from successful restore. SQL
export temporarily fences writers and reconstructs derived search before releasing
the fence; actual recovery stays blocked through owner acceptance. Verification
checks schema, retained rows and the private/public R2 artifact closure.

Evidence/staging writers register before I/O. Cleanup requires positive ownership,
reference guards and settled write/delete tickets for the exact key incarnation.
Neither a timeout, missing HEAD nor another successful delete settles an ambiguous
writer. Permanent decision references must pin physical evidence in the same batch
as the decision. Backup retention and recovery also protect those references.
See [maintenance](../../docs/runbooks/maintenance.md) for operator actions.
