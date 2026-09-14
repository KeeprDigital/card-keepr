// Named queries for the populated Card definition migration seam.
const retainedTables = [
  "catalogue_revisions",
  "revision_cards",
  "revision_printings",
  "game_candidates",
  "game_candidate_partitions",
  "reconciliation_operations",
  "game_publication_operations",
  "catalogue_exports",
  "catalogue_backup_attempts",
  "source_observation_sets",
  "source_snapshots",
  "entity_admission_decisions",
];
export function immutableHistoryStatements(database) {
  return retainedTables.map((table) => ({
    table,
    statement: database.prepare(
      `SELECT ${table === "revision_cards" ? "catalogue_revision_id,card_id,document_json" : table === "revision_printings" ? "catalogue_revision_id,printing_id,card_id,document_json" : "*"} FROM ${table} ORDER BY rowid`,
    ),
  }));
}
export function foreignKeys(database) {
  return database.prepare("PRAGMA foreign_key_check");
}
export function nativeCategory(database) {
  return database.prepare("SELECT category FROM publication_read_entities WHERE kind='cards' AND entity_id=? LIMIT 1");
}
export function nativeReadEntities(database) {
  return database.prepare("SELECT * FROM publication_read_entities ORDER BY candidate_id,kind,entity_id");
}
export function candidateState(database) {
  return database.prepare("SELECT state,generation,manifest_digest FROM game_candidates WHERE id=?");
}
export function changeNativeCategory(database) {
  return database.prepare("UPDATE publication_read_entities SET category='art' WHERE kind='cards'");
}
export function seedLegacyRevision(database) {
  return [
    database.prepare(
      "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES ('category-migration','2026-09-14T00:00:00.000Z','catrev_spine_000','category-migration')",
    ),
    database.prepare(
      "INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES ('category-migration','category-migration','2026-09-14T00:00:00.000Z',?,'catrev_spine_000',?)",
    ),
  ];
}
export function seedLegacyCard(database) {
  return database.prepare(
    "INSERT INTO reconciled_cards(id,supported_game,official_identity_kind,official_identity_value,first_revision_id,last_observed_revision_id) VALUES (?,?,'card_number',?,'category-migration','category-migration')",
  );
}
export function seedLegacyPrinting(database) {
  return database.prepare(
    "INSERT INTO reconciled_printings(id,card_id,source_lineage,artwork_fingerprint,printed_fields_digest,first_revision_id,last_observed_revision_id) VALUES (?,?,'owner','artwork','fields','category-migration','category-migration')",
  );
}
export function seedLegacyDocument(database) {
  return database.prepare("INSERT INTO revision_cards VALUES ('category-migration',?,?)");
}
export function seedLegacyPrintingDocument(database) {
  return database.prepare("INSERT INTO revision_printings VALUES ('category-migration',?,'card',?)");
}
export function selectLegacyRevision(database) {
  return database.prepare("UPDATE catalogue_state SET current_revision_id='category-migration'");
}
export function legacyReadiness(database, kind) {
  return kind === "cards"
    ? database.prepare(
        "SELECT card_id AS id,card_model_ready FROM revision_cards WHERE catalogue_revision_id='category-migration' ORDER BY card_id",
      )
    : database.prepare(
        "SELECT printing_id AS id,card_model_ready FROM revision_printings WHERE catalogue_revision_id='category-migration' ORDER BY printing_id",
      );
}
export function readinessIndexes(database) {
  return database.prepare(
    "SELECT name,sql FROM sqlite_schema WHERE type='index' AND name IN ('revision_cards_unready_model','revision_printings_unready_model') ORDER BY name",
  );
}
export function seedLegacyQuery(database) {
  return database.prepare(
    "INSERT INTO revision_card_query_documents(catalogue_revision_id,card_id,summary_json) VALUES ('category-migration',?,?)",
  );
}
export function legacyCards(database) {
  return database.prepare("SELECT * FROM reconciled_cards ORDER BY id");
}
export function legacyPrintings(database) {
  return database.prepare("SELECT * FROM reconciled_printings ORDER BY id");
}
export function legacyCategories(database) {
  return database.prepare("SELECT card_id,category FROM revision_card_query_documents ORDER BY card_id");
}
export function newArtCard(database) {
  return database.prepare(
    "INSERT INTO reconciled_cards(id,supported_game,category,official_identity_kind,official_identity_value,first_revision_id,last_observed_revision_id) VALUES (?,'gundam','art','card_number','gundam-gameplay','category-migration','category-migration')",
  );
}
export function changeCategory(database) {
  return database.prepare("UPDATE reconciled_cards SET category='art' WHERE id='gundam-gameplay'");
}
export function recoveryFence(database) {
  return database.prepare("UPDATE operation_state SET recovery_restore_guard=?");
}
