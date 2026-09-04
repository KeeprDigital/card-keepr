import { type CatalogueStore, repositoryStatements } from "../../../../src/catalogue/shared";

export async function removeSearchMaterializationTriggers(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS revision_card_search_chunks_insert_fts"),
    database.prepare("DROP TRIGGER IF EXISTS revision_card_search_chunks_before_update_fts"),
    database.prepare("DROP TRIGGER IF EXISTS revision_card_search_chunks_after_update_fts"),
    database.prepare("DROP TRIGGER IF EXISTS revision_card_search_chunks_delete_fts"),
    database.prepare("DROP TRIGGER IF EXISTS archive_removed_card_query_material"),
  ]);
}

export async function seedSearchMaterializationCard(database: D1Database, cardId: string): Promise<void> {
  const summary = JSON.stringify({
    id: cardId,
    game: "one-piece",
    official_identity: { kind: "card_number", value: cardId },
  });
  await database.batch([
    database.prepare("INSERT INTO revision_cards VALUES ('catrev_materialization', ?, ?)").bind(cardId, summary),
    database
      .prepare(
        "INSERT INTO revision_card_query_documents (catalogue_revision_id, card_id, summary_json) VALUES ('catrev_materialization', ?, ?)",
      )
      .bind(cardId, summary),
    database.prepare(
      "INSERT OR IGNORE INTO catalogue_query_revisions (catalogue_revision_id, state) VALUES ('catrev_materialization', 'available')",
    ),
  ]);
}

export function matchingMaterializedCards(database: CatalogueStore, query: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT card_id FROM revision_card_search_fts WHERE revision_card_search_fts MATCH ? ORDER BY card_id")
    .bind(query);
}

export function materializationCounts(database: CatalogueStore, cardId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
    (SELECT count(*) FROM revision_card_search_chunks WHERE card_id = ?) AS chunks,
    (SELECT count(*) FROM revision_card_search_fts_rows WHERE card_id = ?) AS rows,
    (SELECT count(*) FROM revision_card_search_fts WHERE card_id = ?) AS fts`)
    .bind(cardId, cardId, cardId);
}

export function archiveMaterializedRevision(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "UPDATE catalogue_query_revisions SET state = 'archived' WHERE catalogue_revision_id = 'catrev_materialization'",
  );
}

export async function seedSearchMaterializationRevision(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at, expected_current_revision_id, idempotency_key,
      candidate_json, candidate_digest, approval_json
    ) VALUES ('run_materialization', 'publishing', '[]', '2026-09-01T00:00:00.000Z', 'catrev_spine_000',
      'run_materialization', '{}', 'candidate', '{"candidate_digest":"candidate","expected_current_revision_id":"catrev_spine_000"}')`),
    database.prepare("UPDATE operation_state SET active_ingestion_run_id = 'run_materialization' WHERE singleton = 1"),
    database.prepare(`INSERT INTO catalogue_revisions (id, ingestion_run_id, published_at, content_digest,
      expected_previous_revision_id, approved_candidate_digest) VALUES ('catrev_materialization', 'run_materialization',
      '2026-09-01T00:00:00.000Z', 'catalogue', 'catrev_spine_000', 'candidate')`),
    database.prepare("UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1"),
  ]);
}
