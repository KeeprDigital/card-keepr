import {
  type CatalogueStore,
  repositoryStatements,
  atomicRepositoryStatement,
  canonicalJson,
  byteBoundedJsonArrays,
} from "../shared";

export type CorrectionRow = {
  sequence: number;
  id: string;
  game: string;
  request_json: string;
  reviewed_json: string;
  review_digest: string;
  idempotency_key: string;
  decided_at: string;
};
export function correctionStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database).prepare("SELECT * FROM identity_correction_decisions WHERE id = ?").bind(id);
}
export function correctionReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM identity_correction_decisions WHERE idempotency_key = ?")
    .bind(key);
}
export function correctionHistoryStatement(database: CatalogueStore, game: string, after: number) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM identity_correction_decisions WHERE game = ? AND sequence > ? ORDER BY sequence LIMIT 100")
    .bind(game, after);
}
export function correctionStateStatement(database: CatalogueStore) {
  return repositoryStatements(database).prepare(
    "SELECT current_revision_id, (SELECT COALESCE(MAX(sequence), 0) FROM identity_correction_decisions) AS decision_cutoff FROM catalogue_state WHERE singleton = 1",
  );
}
export function correctionEntityStatement(
  database: CatalogueStore,
  kind: "card" | "printing",
  id: string,
  revision: string,
) {
  // Native review evidence binds immutable text digests and lengths as well as
  // identity facts, without materializing arbitrarily large display text.
  const table = kind === "card" ? "revision_cards" : "revision_printings";
  const key = kind === "card" ? "card_id" : "printing_id";
  return repositoryStatements(database)
    .prepare(`SELECT json_set(json_extract(b.content,'$.records[0].value'),
      '$._publication_text_parts',json_extract(b.content,'$.records[0].text_parts')) AS document_json
      FROM catalogue_composition_games m JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
      JOIN publication_projection_batches b ON b.candidate_id=e.candidate_id AND b.ordinal=e.batch_ordinal
      WHERE m.catalogue_revision_id=?1 AND e.kind=?3 AND e.entity_id=?2
      UNION ALL SELECT document_json FROM ${table} WHERE catalogue_revision_id=?1 AND ${key}=?2
      AND NOT EXISTS(SELECT 1 FROM catalogue_revisions WHERE id=?1 AND publication_operation_id IS NOT NULL)
      LIMIT 1`)
    .bind(revision, id, kind === "card" ? "cards" : "printings");
}
export function correctionCardPrintingsStatement(database: CatalogueStore, revision: string, ids: string[]) {
  return repositoryStatements(database)
    .prepare(
      `SELECT e.entity_id AS printing_id,e.card_id FROM catalogue_composition_games m
      JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=?1 AND e.kind='printings' AND e.card_id IN (SELECT value FROM json_each(?2))
      UNION ALL SELECT printing_id,card_id FROM revision_printings WHERE catalogue_revision_id=?1
      AND card_id IN (SELECT value FROM json_each(?2))
      AND NOT EXISTS(SELECT 1 FROM catalogue_revisions WHERE id=?1 AND publication_operation_id IS NOT NULL)
      ORDER BY printing_id LIMIT 1001`,
    )
    .bind(revision, canonicalJson(ids));
}
export function insertCorrectionStatement(
  database: CatalogueStore,
  row: Omit<CorrectionRow, "sequence">,
  revision: string,
  cutoff: number,
) {
  return atomicRepositoryStatement(database, {
    before: [
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN
      (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1) = ? AND (SELECT COALESCE(MAX(sequence), 0) FROM identity_correction_decisions) = ? AND NOT EXISTS (
      SELECT 1 FROM operation_state WHERE singleton = 1 AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked'
      OR (active_production_release_id IS NOT NULL AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
      THEN 1 ELSE json_extract('{}', 'identity_correction_conflict') END`)
        .bind(revision, cutoff),
    ],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO identity_correction_decisions
      (id, game, request_json, reviewed_json, review_digest, idempotency_key, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        row.id,
        row.game,
        row.request_json,
        row.reviewed_json,
        row.review_digest,
        row.idempotency_key,
        row.decided_at,
      ),
  });
}
// Compose these raw statements into the operation-creation batch. Cutoff zero
// is an explicit empty set; replay never takes decisions recorded afterward.
export function correctionPinStatementsForPreparation(
  database: CatalogueStore,
  runId: string,
  games: readonly string[],
) {
  return [
    repositoryStatements(database)
      .prepare(`INSERT OR IGNORE INTO reconciliation_correction_pins
    (preparation_id, games_json, decision_cutoff)
    SELECT operation.id, COALESCE(legacy.games_json, ?),
      COALESCE(legacy.decision_cutoff, (SELECT COALESCE(MAX(sequence), 0) FROM identity_correction_decisions))
    FROM reconciliation_operations AS operation LEFT JOIN identity_correction_run_pins AS legacy
      ON operation.supported_game IS NULL AND legacy.ingestion_run_id = operation.ingestion_run_id
    WHERE operation.id = ?`)
      .bind(canonicalJson([...new Set(games)].sort()), runId),
  ];
}
export function correctionPinStatement(database: CatalogueStore, runId: string) {
  return repositoryStatements(database)
    .prepare("SELECT games_json, decision_cutoff FROM reconciliation_correction_pins WHERE preparation_id = ?")
    .bind(runId);
}
export function pinnedCorrectionsStatement(database: CatalogueStore, runId: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT d.* FROM identity_correction_decisions d JOIN reconciliation_correction_pins p
    ON d.sequence <= p.decision_cutoff AND d.game IN (SELECT value FROM json_each(p.games_json))
    WHERE p.preparation_id = ? AND d.sequence > ? ORDER BY d.sequence LIMIT 1`)
    .bind(runId, after);
}
export function publishCorrectionStatements(
  database: CatalogueStore,
  revision: string,
  corrections: readonly { id: string; entity_kind: string }[],
) {
  return byteBoundedJsonArrays(corrections).map((payload) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO revision_identity_corrections
    (catalogue_revision_id, entity_id, entity_kind, document_json)
    SELECT ?, json_extract(incoming.value, '$.id'), json_extract(incoming.value, '$.entity_kind'), incoming.value FROM json_each(?) incoming
    WHERE NOT EXISTS (SELECT 1 FROM revision_identity_corrections existing WHERE existing.catalogue_revision_id = ?
      AND existing.entity_id = json_extract(incoming.value, '$.id') AND existing.document_json = incoming.value)`)
      .bind(revision, payload, revision),
  );
}

export function correctionPrintingMappingStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT source_observation_id, source_snapshot_id, evidence_json
    FROM canonical_source_mappings WHERE entity_id = ? AND entity_kind = 'printing'
    ORDER BY mapped_at DESC, rowid DESC LIMIT 1`)
    .bind(id);
}
