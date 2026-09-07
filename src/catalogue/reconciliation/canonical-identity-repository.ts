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
export function identityMappingsStatement(
  database: CatalogueStore,
  id: string,
  after: string,
  preparationId: string | null = null,
) {
  if (preparationId)
    return repositoryStatements(database)
      .prepare(`SELECT mapping.*, candidate.state AS publication_state FROM reconciliation_source_mappings AS mapping
      JOIN game_candidates AS candidate ON candidate.id = mapping.preparation_id
      WHERE mapping.preparation_id = ? AND mapping.entity_id = ? AND mapping.source_observation_id > ?
      ORDER BY mapping.source_observation_id LIMIT 101`)
      .bind(preparationId, id, after);
  return repositoryStatements(database)
    .prepare(
      `SELECT * FROM canonical_source_mappings WHERE entity_id = ? AND source_observation_id > ? ORDER BY source_observation_id LIMIT 101`,
    )
    .bind(id, after);
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
export function insertSourceMappingsStatement(database: CatalogueStore, runId: string, payload: string) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO canonical_source_mappings
      (entity_id, entity_kind, source_observation_id, source_lineage, ingestion_run_id,
       source_snapshot_id, source_observation_set_id, locator, variant_key, evidence_json, mapped_at)
      SELECT json_extract(value, '$.entityId'), json_extract(value, '$.kind'),
       json_extract(value, '$.sourceObservationId'), json_extract(value, '$.sourceLineage'),
       (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?1),
       json_extract(value, '$.sourceSnapshotId'), json_extract(value, '$.sourceObservationSetId'),
       json_extract(value, '$.locator'), json_extract(value, '$.variantKey'),
       json_extract(value, '$.evidenceJson'), json_extract(value, '$.mappedAt')
      FROM json_each(?2) WHERE EXISTS (SELECT 1 FROM reconciliation_operations WHERE id = ?1 AND supported_game IS NULL) ON CONFLICT(entity_id, source_observation_id) DO NOTHING`)
      .bind(runId, payload),
    before: [identityRunGuard(database, runId)],
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO reconciliation_source_mappings
        (preparation_id, entity_id, entity_kind, source_observation_id, source_lineage, ingestion_run_id,
         source_snapshot_id, source_observation_set_id, locator, variant_key, evidence_json, mapped_at)
        SELECT operation.id, json_extract(value, '$.entityId'), json_extract(value, '$.kind'),
          json_extract(value, '$.sourceObservationId'), json_extract(value, '$.sourceLineage'), operation.ingestion_run_id,
          json_extract(value, '$.sourceSnapshotId'), json_extract(value, '$.sourceObservationSetId'),
          json_extract(value, '$.locator'), json_extract(value, '$.variantKey'),
          json_extract(value, '$.evidenceJson'), json_extract(value, '$.mappedAt')
        FROM reconciliation_operations AS operation, json_each(?2)
        WHERE operation.id = ?1 AND operation.supported_game IS NOT NULL
        ON CONFLICT(preparation_id, entity_id, source_observation_id) DO NOTHING`)
        .bind(runId, payload),
    ],
  });
}
export function identityRunGuard(database: CatalogueStore, run: string) {
  return repositoryStatements(database)
    .prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM operation_state AS operation
    WHERE operation.singleton = 1 AND operation.recovery_health <> 'blocked'
      AND (EXISTS (SELECT 1 FROM reconciliation_operations AS preparation
        JOIN game_candidate_slots AS slot ON slot.preparation_id = preparation.id
        WHERE preparation.id = ?1 AND preparation.supported_game IS NOT NULL AND preparation.state = 'preparing')
      OR EXISTS (SELECT 1 FROM ingestion_run_current AS run
        JOIN ingestion_collection_reservations AS reservation ON reservation.ingestion_run_id = run.ingestion_run_id
        WHERE run.ingestion_run_id = ?1 AND run.state IN ('parsing', 'reconciling')))
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
      VALUES (?, (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?), ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
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
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO canonical_identity_review_runs
      (review_id, ingestion_run_id, source_observation_id, source_snapshot_id) VALUES (?, (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?), ?, ?)
      ON CONFLICT(review_id, ingestion_run_id) DO NOTHING`)
        .bind(review.id, review.ingestion_run_id, review.source_observation_id, review.source_snapshot_id),
      repositoryStatements(database)
        .prepare(`INSERT INTO reconciliation_identity_reviews (preparation_id, review_id, source_observation_id, source_snapshot_id)
          SELECT id, ?2, ?3, ?4 FROM reconciliation_operations WHERE id = ?1 AND supported_game IS NOT NULL
          ON CONFLICT(preparation_id, review_id) DO NOTHING`)
        .bind(review.ingestion_run_id, review.id, review.source_observation_id, review.source_snapshot_id),
    ],
  });
}
export function identityReviewStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database).prepare("SELECT * FROM canonical_identity_reviews WHERE id = ?").bind(id);
}
export function identityReviewsStatement(
  database: CatalogueStore,
  run: string,
  after: string,
  preparationId: string | null = null,
) {
  if (preparationId)
    return repositoryStatements(database)
      .prepare(`SELECT review.id, review.source_lineage, review.evidence_json, review.candidate_printing_ids_json, review.created_at,
      preparation.ingestion_run_id, capture.preparation_id, capture.source_observation_id, capture.source_snapshot_id
      FROM reconciliation_identity_reviews AS capture JOIN canonical_identity_reviews AS review ON review.id = capture.review_id
      JOIN reconciliation_operations AS preparation ON preparation.id = capture.preparation_id
      WHERE capture.preparation_id = ? AND capture.review_id > ? ORDER BY capture.review_id LIMIT 101`)
      .bind(preparationId, after);
  return repositoryStatements(database)
    .prepare(`SELECT review.id, review.source_lineage, review.evidence_json, review.candidate_printing_ids_json, review.created_at,
       capture.ingestion_run_id, capture.source_observation_id, capture.source_snapshot_id
       FROM canonical_identity_reviews AS review JOIN canonical_identity_review_runs AS capture ON capture.review_id = review.id
       WHERE capture.ingestion_run_id = ? AND review.id > ? ORDER BY review.id LIMIT 101`)
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
export function identityDecisionStatement(database: CatalogueStore, id: string, runId?: string) {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM canonical_identity_decisions WHERE review_id = ?
      AND (? IS NULL OR rowid <= (SELECT identity_decision_cutoff FROM reconciliation_operations WHERE id = ?))`)
    .bind(id, runId ?? null, runId ?? null);
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
