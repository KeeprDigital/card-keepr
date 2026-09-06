import { type CatalogueStore, repositoryStatements, atomicRepositoryStatement } from "../shared";

export function allocateIdentityStatement(
  database: CatalogueStore,
  key: string,
  id: string,
  kind: string,
  at: string,
  run: string,
) {
  const statements = repositoryStatements(database);
  return atomicRepositoryStatement(database, {
    statement: statements
      .prepare(`INSERT INTO canonical_identity_allocations
      (allocation_key, entity_id, entity_kind, allocated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(allocation_key) DO NOTHING`)
      .bind(key, id, kind, at),
    before: [identityRunGuard(database, run)],
  });
}
export function allocatedIdentityStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT entity_id FROM canonical_identity_allocations WHERE allocation_key = ?")
    .bind(key);
}
export function identityAllocationStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare("SELECT entity_kind FROM canonical_identity_allocations WHERE entity_id = ?")
    .bind(id);
}
export function identityMappingsStatement(database: CatalogueStore, id: string, after: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT * FROM canonical_source_mappings WHERE entity_id = ? ORDER BY mapped_at, source_observation_id LIMIT 501`,
    )
    .bind(id);
}
export type SourceMapping = {
  entityId: string;
  kind: "card" | "printing";
  sourceObservationId: string;
  sourceLineage: string;
  runId: string;
  sourceSnapshotId: string;
  sourceObservationSetId: string;
  locator: string | null;
  variantKey: string | null;
  evidenceJson: string;
  mappedAt: string;
};
export function insertSourceMappingStatement(database: CatalogueStore, mapping: SourceMapping) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO canonical_source_mappings
      (entity_id, entity_kind, source_observation_id, source_lineage, ingestion_run_id,
       source_snapshot_id, source_observation_set_id, locator, variant_key, evidence_json, mapped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entity_id, source_observation_id) DO NOTHING`)
      .bind(
        mapping.entityId,
        mapping.kind,
        mapping.sourceObservationId,
        mapping.sourceLineage,
        mapping.runId,
        mapping.sourceSnapshotId,
        mapping.sourceObservationSetId,
        mapping.locator,
        mapping.variantKey,
        mapping.evidenceJson,
        mapping.mappedAt,
      ),
    before: [identityRunGuard(database, mapping.runId)],
  });
}
function identityRunGuard(database: CatalogueStore, run: string) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM operation_state AS operation JOIN ingestion_run_current AS run
      ON run.ingestion_run_id = operation.active_ingestion_run_id
    WHERE operation.singleton = 1 AND run.ingestion_run_id = ?
      AND run.state IN ('parsing', 'reconciling') AND operation.recovery_health <> 'blocked'
      AND (operation.active_production_release_id IS NULL OR operation.active_production_release_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) THEN 1 ELSE json_extract('{}', 'canonical_identity_run_not_active') END`)
    .bind(run);
}

export type IdentityReview = {
  id: string;
  ingestion_run_id: string;
  source_lineage: string;
  source_observation_id: string;
  source_snapshot_id: string;
  evidence_json: string;
  candidate_printing_ids_json: string;
  created_at: string;
};
export function insertIdentityReviewStatement(database: CatalogueStore, review: IdentityReview) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO canonical_identity_reviews
      (id, ingestion_run_id, source_lineage, source_observation_id, source_snapshot_id, evidence_json, candidate_printing_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(
        review.id,
        review.ingestion_run_id,
        review.source_lineage,
        review.source_observation_id,
        review.source_snapshot_id,
        review.evidence_json,
        review.candidate_printing_ids_json,
        review.created_at,
      ),
    before: [identityRunGuard(database, review.ingestion_run_id)],
  });
}
export function identityReviewStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database).prepare("SELECT * FROM canonical_identity_reviews WHERE id = ?").bind(id);
}
export function identityReviewsStatement(database: CatalogueStore, run: string, after: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM canonical_identity_reviews WHERE ingestion_run_id = ? AND id > ? ORDER BY id LIMIT 101")
    .bind(run, after);
}
export type IdentityDecision = {
  review_id: string;
  printing_id: string;
  rationale: string;
  idempotency_key: string;
  request_json: string;
  decided_at: string;
};
export function identityDecisionStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM canonical_identity_decisions WHERE review_id = ?")
    .bind(id);
}
export function insertIdentityDecisionStatement(database: CatalogueStore, decision: IdentityDecision) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO canonical_identity_decisions
      (review_id, printing_id, rationale, idempotency_key, request_json, decided_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        decision.review_id,
        decision.printing_id,
        decision.rationale,
        decision.idempotency_key,
        decision.request_json,
        decision.decided_at,
      ),
    before: [
      repositoryStatements(database).prepare(`SELECT CASE WHEN EXISTS (
      SELECT 1 FROM operation_state WHERE singleton = 1 AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked'
      OR (active_production_release_id IS NOT NULL AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
      THEN json_extract('{}', 'identity_decision_operation_not_idle') ELSE 1 END`),
    ],
  });
}
