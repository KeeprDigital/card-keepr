# Catalogue clusters

`src/catalogue` is ten cluster directories. It got there by an
expand-contract series:

- **#96 (expand)**: each cluster directory gained an `index.ts` that
  re-exported its intended public surface from the flat files.
- **#97 (migrate)**: each flat file moved into its cluster and imports were
  repointed at the cluster indexes.
- **#98 (contract)**: the compatibility re-exports were removed, the read
  paths that reached past published projections were given
  projection-backed alternatives (migration `0004_read_projection_facts.sql`),
  and the boundary below became a CI gate.

## The contract, and how it is enforced

Two scripts run in the `checks` job of `.github/workflows/ci.yml`:

- `npm run check:catalogue-cycles` (`scripts/catalogue-import-cycles.mjs`)
  walks every module under `src/catalogue` and fails on any import cycle.
- `npm run check:catalogue-boundary`
  (`scripts/catalogue-import-boundary.mjs`) walks the worker entrypoints,
  `src/http`, and every module under `src/catalogue`, resolves each
  relative import, and fails on any edge that breaks a rule below. A
  violation names the importing file, the import specifier, and the rule.

The rules:

| Rule | What it enforces |
| --- | --- |
| `api-worker-surface` | `apps/api/src/**` imports, out of `src/`, only the `read` and `shared` cluster indexes, `src/http/**`, and `src/runtime-capabilities.mjs`. The api worker never reaches an administration cluster or a cluster internal. |
| `worker-cluster-index` | A worker entrypoint imports a catalogue cluster only through its `index.ts`. |
| `cluster-direction` | A module under `src/catalogue/<cluster>/` imports only the clusters listed for it under "Dependency direction" below. In particular no `read` module imports `ingestion`, `reconciliation`, `curated`, or `source-evidence`, and `shared` imports no other cluster. |
| `cluster-index` | A cross-cluster import targets the cluster's `index.ts`, never a module inside it. Within a cluster, modules import each other by relative path. |
| `http-leaf` | `src/http/**` imports nothing under `src/catalogue`, so the api worker cannot reach a cluster through it. |

Type-only imports count. Tests, scripts, the CLI, and acceptance may
import cluster internals by path; they are not scanned.

The boundary is also a data contract: the `read` cluster queries only
published projections (`catalogue_state`, `catalogue_revisions`,
`catalogue_query_revisions`, `revision_*`, `card_search_fts_state`,
`catalogue_exports`, `catalogue_export_deletion*`,
`catalogue_curated_provenance`, `source_freshness`), never a
reconciliation, source-evidence, or curated table. The facts it serves are
written into those tables at publication time by the owning cluster:

- Printing Image content (`read.ts`) used to join
  `reconciled_printing_images`; `revision_printing_images` now carries
  `media_type`, `content_sha256`, `content_byte_length`, and `object_key`,
  written by the `ingestion` cluster's publication statements.
- Historical Legality Status and Product evidence sidecars used published
  evidence projections. Issue #217 removes these consumer surfaces under ADRs
  0013–0014; their retained administrative and recovery evidence remains intact.

Migration 0004 backfills the two new column sets on a populated database
and adds an `AFTER INSERT` guard on each table that rejects a revision row
without them (`acceptance/schema-hygiene.test.mjs` proves both).

## Which cluster owns which file

Every module belongs to exactly one cluster directory (the former flat
file names are unchanged). The right-hand column is the public surface the
cluster's `index.ts` re-exports; anything a module exports that is not
listed there is cluster-internal. The rule for what an index exposes:
whatever a worker entrypoint, another cluster, a script, the CLI,
acceptance, or a test consumes. No index uses `export *`; every re-export
is enumerated, and each is re-exported from the module that defines it.

| Cluster | Files | Public surface (`index.ts`) |
| --- | --- | --- |
| `shared` | `serialization.ts`, `export-compression.ts`, `calendar-date.ts`, `streaming-sha256.ts`, `idempotent-identities.ts`, `administration-problem.ts`, `operational-diagnostics.ts`, `spine-revision.mjs` (+ `.d.mts`), `catalogue-candidate-types.ts`, `ingestion-run-state.ts`, `workflow-driver.ts`, `workflow-steps.ts`, `workflow-progress.ts`, `curated-provenance.ts`, `reconciliation-profile.ts`, `reconciliation-payload.ts`, `export-limits.ts` | Canonical JSON and hashing, deterministic gzip, calendar-date check, streaming SHA-256, idempotent identities, `AdministrationProblem`, operational diagnostics, `SPINE_REVISION_ID`, the Catalogue Candidate contract and its leaf types, Curated Provenance types, Game Profile contract helpers, D1 payload chunking and the guarded atomic batch, export limits, Ingestion Run state and transition contract, Workflow driver and named-step contract |
| `read` | `read.ts`, `detail-representation.ts`, `card-collection-read.ts`, `printing-collection-read.ts`, `product-release-read.ts`, `card-search.ts`, `source-freshness.ts` | The api worker's response builders and read problems (cards, printings, products, exports, status), the card-search text and query contract, source-freshness storage helpers |
| `ingestion` | `ingestion.ts`, `candidate-inspection.ts`, `catalogue-revision-retention.ts`, `card-search-materialization.ts`, `card-search-repair-administration.ts`, `production-release.ts` | Ingestion Run administration (`approveRun`, `rejectRun`, `retryRun`, `retryPublicationCleanup`, `showRun`, `inspectCandidate`, `administrationStatus`), Production Release smoke targets, guarded card-search repair, `prepareProductionRelease` |
| `reconciliation` | `card-printing-reconciliation.ts`, `digimon-reconciliation.ts`, `errata-rules-text.ts`, `reconciliation-candidate-store.ts`, `reconciliation-evidence.ts`, `reconciliation-model.ts`, `reconciliation-observation.ts`, `reconciliation-publication.ts`, `reconciliation-read.ts`, `reconciliation-relationships.ts`, `reconciliation-repository.ts`, `reconciliation-workflow.ts`, `product-release-catalogue.ts`, `product-release-projection.ts`, `product-release-publication.ts`, `publication-lifecycle-types.ts` | Card and Printing reconciliation entry points, the reconciliation Workflow, candidate persistence (`digestBoundCandidatePayload`, `failReconciliationWorkflow`, `retainedReconciliationResult`), the publication plan and its evidence types, observation parsing, Gundam listing-graph validation, erratum export helpers, Product and Release reconciliation, projection, and publication statements |
| `source-evidence` | `source-evidence.ts`, `source-evidence-batch.ts`, `source-evidence-capture.ts`, `source-evidence-model.ts`, `source-evidence-parsing.ts`, `source-evidence-repository.ts`, `source-evidence-repository-types.ts`, `collection-inspection.ts`, `collection-recovery.ts`, `workflow-progress.ts` | Evidence run administration (start, retry, show, extend capacity, reparse, snapshot and observation-set content), request batch collection, capture and host pacing, Evidence Plan parsing and request failure policy, the evidence repository's run, request, pause, resume, terminate, and Workflow Attempt operations, collection Workflow classification |
| `adapters` | `source-adapters.ts`, `source-adapter-registration-types.ts`, `product-release-source-adapters.ts`, `one-piece-source-adapter.ts`, `one-piece-official-errata-html.ts`, `official-artwork-identity.ts`, `official-legality-live-html.ts`, `official-legality-source-adapters.ts`, `official-source-field-coverage.ts`, `official-source-release-normalization.ts`, `official-source-scope.ts` | Source Adapter Version registrations and lookups, adapter binding and request-surface assertions, the Official Source scope, discovery requests, official artwork identity, the One Piece errata parser, the official legality-rules observation |
| `curated` | `curated-revisions.ts` | Curated Revision administration (validate, create, reaffirm, retire, supersede, list, show), run pinning and application, curated publication statements |
| `legality` | `legality-rule.ts`, `legality-rule-lifecycle.ts`, `legality-effect-policy.ts`, `legality-export.ts`, `legality-publication.ts`, `stored-legality-documents.ts` | Legality Rule canonicalisation, retained-rule parsing, card resolution, lifecycle, effect evaluation, export records, publication statements, stored-document parsers |
| `backup-recovery` | `backup-recovery.ts`, `backup-workflow.ts`, `recovery.ts`, `card-search-recovery.ts`, `card-search-recovery-statements.ts` | Backup Attempt creation, status, and verification, the backup Workflow, Catalogue Recovery (begin, inspect, verify, accept, restore guard), the D1 providers, card-search export and restore reconstruction |
| `export` | `export.ts`, `export-validation.ts`, `catalogue-export-deletion.ts` | `buildCatalogueExport` and its types, export record and manifest verification, Catalogue Export deletion |

## Dependency direction

`shared` imports nothing outside itself. The direction between the other
clusters, read as "may import from", is the `allowedImports` table the
boundary check enforces:

- `adapters` -> `shared`
- `legality` -> `shared`, `adapters`
- `read` -> `shared`, `legality`, `adapters`
- `curated` -> `shared`, `legality`
- `source-evidence` -> `shared`, `adapters`, `curated`
- `reconciliation` -> `shared`, `adapters`, `legality`, `curated`, `source-evidence`
- `export` -> `shared`, `legality`, `reconciliation`
- `backup-recovery` -> `shared`, `read`, `legality`
- `ingestion` -> every cluster

The api worker imports `read` and `shared` only. Consumer serialization uses the
shared card-content projection; source-health and evidence metadata remain
administrative. The ingestion worker imports the other domain clusters.

## Edges #97 repointed to keep the cluster graph acyclic

The flat module graph was acyclic, but three edges crossed clusters against
the direction above. Each was a compatibility re-export whose real owner is
`shared`, so #97 repointed the import at the owner, removing the edge:

- `source-evidence-*.ts`, `card-printing-reconciliation.ts`,
  `reconciliation-workflow.ts`, and `card-search-repair-administration.ts`
  import `AdministrationProblem` from `./ingestion`; the owner is
  `administration-problem.ts` (`shared`). The `ingestion` index deliberately
  does not re-export it.
- `curated-revisions.ts` imports `type ProductRelationship` from
  `./product-release-catalogue`; the type is defined in
  `catalogue-candidate-types.ts` (`shared`).
- `source-freshness.ts` imports `type LegalityRegion` from
  `./legality-rule`; the type is defined in `catalogue-candidate-types.ts`
  (`shared`).

The other compatibility re-exports (`catalogue-candidate.ts`, the
`ListingReconciliationTraits` re-export on `source-adapters.ts`, the type
re-exports on `legality-rule.ts`, `legality-effect-policy.ts`,
`product-release-catalogue.ts`, `errata-rules-text.ts`,
`reconciliation-publication.ts`, and `source-evidence-repository.ts`,
`AdministrationProblem` on `ingestion.ts`, and `deterministicGzip` on
`serialization.ts`) were removed by #98 once nothing imported them.

## Placement notes

- `card-search.ts` sits in `read` because the API serves it; ingestion
  materialises against the same contract. The historical `source-freshness.ts`
  storage helpers remain used by ingestion, while consumer freshness is removed.
- `reconciliation-profile.ts` and `reconciliation-payload.ts` sit in
  `shared` despite their names: the Game Profile contract is consumed by
  `legality`, `curated`, `export`, and `reconciliation`, and the payload
  chunking by every cluster that writes publication statements. They kept
  their names when they moved.
- `curated-provenance.ts` sits in `shared` because
  `catalogue-candidate-types.ts` imports it; keeping it in `curated` would
  make `shared` depend on `curated`.
- `collection-recovery.ts` is collection Workflow recovery (Workflow Pause,
  Workflow Attempt), so it belongs to `source-evidence`, not to
  `backup-recovery`, which is Backup Attempt and Catalogue Recovery.
- `official-legality-*.ts` and `official-source-scope.ts` are Official
  Source parsers and scope registration, so they belong to `adapters`, not
  `legality`.

## Aggregate repositories (#103 expand, #104 migrate)

The repository functions introduced by #103 prepare and bind SQL; their callers
still execute reads and writes and compose atomic batches. Query row types live
beside the statements (or in the existing retained-evidence types module), and
the existing typed readers preserve missing-row and validation behavior. No
statement factory executes a query, checks a capability, or opens a transaction.
The existing reconciliation repository also retains its older read helpers during
this expansion.

| Aggregate | Repository | First adopted path |
| --- | --- | --- |
| Catalogue Revision | `ingestion/catalogue-revision-repository.ts` | Retained revision window and repair target readers |
| Ingestion Run | `source-evidence/ingestion-run-repository.ts` | Evidence run start/retry insertion and evidence run readers |
| Source evidence | `source-evidence/evidence-repository.ts` | Fetch Attempt insertion and reused Source Snapshot reader |
| Reconciliation | `reconciliation/reconciliation-repository.ts` | Terminal result insertion and reader |
| Curated Revision | `curated/curated-repository.ts` | Revision readers and reaffirm/retire lifecycle batch |
| Backup Attempt | `backup-recovery/backup-repository.ts` | Attempt evidence reader and Restore Phase transition |
| Catalogue Export | `export/export-repository.ts` | Export reader and deletion plan insertion |

These are cluster-internal seams. #104 moves the remaining SQL into named
repository factories, including published read queries, retained evidence,
reconciliation publication, Workflow progress, and the Card/Printing query
projections. Existing cluster entrypoints stay unchanged. Domain callers own
execution and batch composition; the repositories prepare statements and bind
closed, typed inputs. Dynamic table choices are selected inside the repository.
#105 contracts that argument to `CatalogueStore`: a branded port exposing atomic
batch execution, without SQL preparation or other D1 operations. Worker
composition adapts the binding; only repository factories can request the
statement-preparation capability. The boundary gate rejects raw D1 types and
repository capability access in domain modules.
Every supported database has the current lifecycle shape; there is no capability
probe or legacy write branch. Curated lifecycle batches retain statement
ordering, event-version predicates, and append-only audit/idempotency writes.
Backup transitions retain their owner-token, state, and phase predicates, with
the caller still checking the affected-row count.


## Repository guards and materialization

Migration `0011_repository_guards.sql` moves mutable authority and state checks
into named repository recipes. `atomicRepositoryStatement` binds each primary
mutation to its before/after guards and side effects. CatalogueStore expands
those recipes into one native D1 batch and returns only primary results in the
caller's original order. A failed guard rolls back every sibling write; direct
execution uses the same transaction path. Expanded batches above 900 statements
are rejected before any write.

The level-10 schema had 175 triggers and 98 tables. Level 11 has 103 triggers,
all protecting immutable rows or fields, and 95 tables. The unconditional
Legality Card-ID update prohibition remains an immutability guard. Export
Deletion identity protection is retained separately from its former state guard.
The two transition audit tables, short-search terms, and legacy lease columns
are removed. Run progress and resume identity use retained run/attempt facts;
release transfer uses the prepared request, idempotency result, state, and lease.
Short search uses existing indexed chunks. Search repair now names its progress
`repair_chunk_offset`; partial cursors restart safely during migration.

Search FTS rows, archived query cleanup, Legality applicability, and retained
source evidence are explicit atomic repository effects. Tests remove the old
trigger family before exercising real repository rejection and rollback paths.
Bulk writers guard byte-bounded groups rather than adding one query per row.
Repeated Product Relationship IDs split groups in input order so evidence from
intermediate updates is retained within the same native transaction.


## Ingestion Run events

Migration `0012_ingestion_run_events.sql` preserves the `ingestion_runs` identity
anchor and its foreign keys. Mutable run facts live in `ingestion_run_current`,
with ordered selected games in a child projection. Each accepted repository CAS
updates the typed projection, checks its guards, and appends an immutable event
containing the accepted scalar result in the same native transaction. Rejected
writes and losing replays append nothing. Candidate and diagnostic payloads are
stored once in immutable, byte-bounded event chunks; later events retain their
references. Existing reconciliation candidate markers still refer to the
original immutable candidate chunks.

The read view renders the existing administration representation from those
facts, including progress and ordered approval decisions. State-authorized
mutations and external-effect authority checks verify the current projection
against the latest event and its birth selection. An absent or corrupted
projection cannot release an existing run's active reservation.

`projectIngestionRunEvent` validates and folds retained events without a clock or
external effects. `rebuildRunProjection` requires an existing production-release
or blocked-recovery maintenance owner, pages the history, validates payload
completeness, and replaces one run's projection and selection atomically. A final
history CAS rejects concurrent advancement. Rebuild neither appends events nor
replays retrieval, publication, backup, or Workflow operations. Level 12 requires
an empty pre-Go-Live run dataset: release preflight reports regeneration required
before claiming that migration, and the migration independently rejects existing
runs. Production recreation remains an explicit operational action.
