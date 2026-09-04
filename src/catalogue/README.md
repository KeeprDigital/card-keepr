# Catalogue clusters

`src/catalogue` is being moved from one flat directory into ten cluster
directories by an expand-contract series:

- **#96 (expand, done)**: each cluster directory exists with an
  `index.ts` that re-exports its intended public surface from the flat
  files. Nothing has moved; every existing import keeps working.
- **#97 (migrate, this step)**: each flat file moves into its cluster, one
  cluster per commit, and imports are repointed at the cluster indexes.
  Cross-cluster imports go through indexes only; within a cluster, modules
  import each other by relative path.
- **#98 (contract)**: the flat layout and compatibility re-exports are
  removed, and a boundary check enforces that the api worker imports only
  `read` and `shared`, and that no `read` module imports `ingestion`,
  `reconciliation`, or `curated` internals.

`npm run check:catalogue-cycles` walks every module under `src/catalogue`,
including the cluster directories, and fails on any import cycle.

## Which cluster owns which file

Every module belongs to exactly one cluster directory (the former flat
file names are unchanged). The right-hand column is the public surface the
cluster's `index.ts` re-exports today; anything a module exports that is
not listed there is cluster-internal.

| Cluster | Files | Public surface (`index.ts`) |
| --- | --- | --- |
| `shared` | `serialization.ts`, `export-compression.ts`, `calendar-date.ts`, `streaming-sha256.ts`, `idempotent-identities.ts`, `administration-problem.ts`, `operational-diagnostics.ts`, `spine-revision.mjs` (+ `.d.mts`), `catalogue-candidate-types.ts`, `catalogue-candidate.ts`, `curated-provenance.ts`, `reconciliation-profile.ts`, `reconciliation-payload.ts`, `export-limits.ts` | Canonical JSON and hashing, deterministic gzip, calendar-date check, streaming SHA-256, idempotent identities, `AdministrationProblem`, operational diagnostics, `SPINE_REVISION_ID`, the Catalogue Candidate contract and its leaf types, Curated Provenance types, Game Profile contract helpers, D1 payload chunking and the guarded atomic batch, export limits |
| `read` | `read.ts`, `detail-representation.ts`, `card-collection-read.ts`, `printing-collection-read.ts`, `product-release-read.ts`, `legality-status.ts`, `card-search.ts`, `source-freshness.ts` | The api worker's response builders and read problems (cards, printings, products, exports, status, Legality Status), the card-search text and query contract, source-freshness storage helpers |
| `ingestion` | `ingestion.ts`, `fixture.ts`, `candidate-inspection.ts`, `catalogue-revision-retention.ts`, `card-search-materialization.ts`, `card-search-repair-administration.ts`, `production-release.ts` | Ingestion Run administration (`startFixtureRun`, `approveRun`, `rejectRun`, `retryRun`, `retryPublicationCleanup`, `showRun`, `inspectCandidate`, `administrationStatus`), Production Release smoke targets, fixture helpers, guarded card-search repair, `prepareProductionRelease` |
| `reconciliation` | `card-printing-reconciliation.ts`, `digimon-reconciliation.ts`, `errata-rules-text.ts`, `reconciliation-candidate-store.ts`, `reconciliation-evidence.ts`, `reconciliation-model.ts`, `reconciliation-observation.ts`, `reconciliation-publication.ts`, `reconciliation-read.ts`, `reconciliation-relationships.ts`, `reconciliation-repository.ts`, `reconciliation-workflow.ts`, `product-release-catalogue.ts`, `product-release-projection.ts`, `product-release-publication.ts`, `publication-lifecycle-types.ts` | Card and Printing reconciliation entry points, the reconciliation Workflow, candidate persistence (`digestBoundCandidatePayload`, `failReconciliationWorkflow`, `retainedReconciliationResult`), the publication plan and its evidence types, observation parsing, Gundam listing-graph validation, erratum export helpers, Product and Release reconciliation, projection, and publication statements |
| `source-evidence` | `source-evidence.ts`, `source-evidence-batch.ts`, `source-evidence-capture.ts`, `source-evidence-model.ts`, `source-evidence-parsing.ts`, `source-evidence-repository.ts`, `source-evidence-repository-types.ts`, `collection-inspection.ts`, `collection-recovery.ts` | Evidence run administration (start, retry, show, extend capacity, reparse, snapshot and observation-set content), request batch collection, capture and host pacing, Evidence Plan parsing and request failure policy, the evidence repository's run, request, pause, resume, terminate, and Workflow Attempt operations, collection Workflow classification |
| `adapters` | `source-adapters.ts`, `source-adapter-registration-types.ts`, `product-release-source-adapters.ts`, `one-piece-source-adapter.ts`, `one-piece-official-errata-html.ts`, `official-artwork-identity.ts`, `official-legality-live-html.ts`, `official-legality-source-adapters.ts`, `official-source-field-coverage.ts`, `official-source-release-normalization.ts`, `official-source-scope.ts` | Source Adapter Version registrations and lookups, adapter binding and request-surface assertions, the Official Source scope, discovery requests, official artwork identity, the One Piece errata parser, the official legality-rules observation |
| `curated` | `curated-revisions.ts` | Curated Revision administration (validate, create, reaffirm, retire, supersede, list, show), run pinning and application, curated publication statements |
| `legality` | `legality-rule.ts`, `legality-rule-lifecycle.ts`, `legality-effect-policy.ts`, `legality-export.ts`, `legality-publication.ts`, `stored-legality-documents.ts` | Legality Rule canonicalisation, retained-rule parsing, card resolution, lifecycle, effect evaluation, export records, publication statements, stored-document parsers |
| `backup-recovery` | `backup-recovery.ts`, `backup-workflow.ts`, `recovery.ts`, `card-search-recovery.ts`, `card-search-recovery-statements.ts` | Backup Attempt creation, status, and verification, the backup Workflow, Catalogue Recovery (begin, inspect, verify, accept, restore guard), the D1 providers, card-search export and restore reconstruction |
| `export` | `export.ts`, `export-validation.ts`, `catalogue-export-deletion.ts` | `buildCatalogueExport` and its types, export record and manifest verification, Catalogue Export deletion |

No index uses `export *`; every re-export is enumerated. The rule for what
an index exposes: whatever a worker entrypoint, another cluster, a script,
the CLI, acceptance, or a test consumes today. Tests may keep importing
cluster-internal modules by path after #97; #98 decides whether to narrow
the surfaces to worker and cross-cluster use only.

## Dependency direction

`shared` imports nothing outside itself. The intended direction between the
other clusters, read as "may import from":

- `adapters` -> `shared`
- `legality` -> `shared`, `adapters`
- `read` -> `shared`, `legality`, `adapters`
- `curated` -> `shared`, `legality`
- `source-evidence` -> `shared`, `adapters`, `curated`
- `reconciliation` -> `shared`, `adapters`, `legality`, `curated`, `source-evidence`
- `export` -> `shared`, `legality`, `reconciliation`
- `backup-recovery` -> `shared`, `read`, `legality`
- `ingestion` -> every cluster

The api worker imports `read` only (its transitive reach into `legality`
and `adapters` through `legality-status.ts` and `source-freshness.ts` is
what #98 addresses); the ingestion worker imports everything else.

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

Other compatibility re-exports that #98 removes once nothing imports them:
`catalogue-candidate.ts` (a re-export of `catalogue-candidate-types.ts`),
the `ListingReconciliationTraits` re-export on `source-adapters.ts`, the
type re-exports on `legality-rule.ts` and `product-release-catalogue.ts`,
and `deterministicGzip` on `serialization.ts`.

## Placement notes

- `card-search.ts` and `source-freshness.ts` sit in `read` because the api
  serves them; the ingestion side materialises against the same contract,
  so `ingestion -> read` is an intended edge (as `backup-recovery -> read`
  already is for verification).
- `legality-status.ts` sits in `read` because it is an api response; the
  Legality Rule model it evaluates is `legality`.
- `reconciliation-profile.ts` and `reconciliation-payload.ts` sit in
  `shared` despite their names: the Game Profile contract is consumed by
  `legality`, `curated`, `export`, and `reconciliation`, and the payload
  chunking by every cluster that writes publication statements. Renaming
  them is #97's call when they move.
- `curated-provenance.ts` sits in `shared` because
  `catalogue-candidate-types.ts` imports it; keeping it in `curated` would
  make `shared` depend on `curated`.
- `collection-recovery.ts` is collection Workflow recovery (Workflow Pause,
  Workflow Attempt), so it belongs to `source-evidence`, not to
  `backup-recovery`, which is Backup Attempt and Catalogue Recovery.
- `official-legality-*.ts` and `official-source-scope.ts` are Official
  Source parsers and scope registration, so they belong to `adapters`, not
  `legality`.
