// Fixed synthetic fixtures and schema probes for the populated Riftbound migration.
const tables = new Set([
  "reconciled_errata",
  "source_freshness",
  "curated_revisions",
  "reconciliation_checkpoints",
  "ingestion_run_selected_games",
  "revision_errata",
  "erratum_provenance",
  "curated_revision_events",
  "catalogue_state",
  "catalogue_revisions",
  "catalogue_exports",
  "catalogue_query_revisions",
  "catalogue_backup_attempts",
  "revision_printing_query",
  "revision_printing_product_query",
  "revision_printings",
  "revision_products",
]);

export function seedRun(db) {
  return db.prepare(
    "INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,?,?,?)",
  );
}

export function seedSelectedGame(db) {
  return db.prepare("INSERT INTO ingestion_run_selected_games VALUES (?,0,'one-piece')");
}

export function seedRevision(db) {
  return db.prepare(
    "INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest) VALUES (?,?,?,?,?,?)",
  );
}

export function seedPrinting(db) {
  return db.prepare("INSERT INTO revision_printings VALUES (?,?,?,'{}')");
}

export function seedProduct(db) {
  return db.prepare("INSERT INTO revision_products VALUES (?,?,'one-piece','TEST','Test','test','[]','{}')");
}

export function seedPrintingQuery(db) {
  return db.prepare("INSERT INTO revision_printing_query VALUES (?,?,?,'one-piece','common')");
}

export function seedPrintingProductQuery(db) {
  return db.prepare("INSERT INTO revision_printing_product_query VALUES (?,?,?,?,'')");
}

export function seedQueryRevision(db) {
  return db.prepare("INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES (?,'available')");
}

export function seedExport(db) {
  return db.prepare(
    "INSERT INTO catalogue_exports(catalogue_revision_id,manifest_key,manifest_digest,verified) VALUES (?,?,?,1)",
  );
}

export function seedBackup(db) {
  return db.prepare(
    "INSERT INTO catalogue_backup_attempts(idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at) VALUES (?,'{}',?,?,'pending',?,?)",
  );
}

export function seedErratum(db) {
  return db.prepare(
    "INSERT INTO reconciled_errata VALUES (?,'one-piece','card',?,NULL,'Correction','\"Corrected\"',?,?)",
  );
}

export function seedRevisionErratum(db) {
  return db.prepare("INSERT INTO revision_errata VALUES (?,?)");
}

export function seedErratumProvenance(db) {
  return db.prepare("INSERT INTO erratum_provenance VALUES (?,'one-piece-en',?,?,?)");
}

export function seedCuratedRevision(db) {
  return db.prepare(
    "INSERT INTO curated_revisions VALUES (?,'one-piece',?,'field',NULL,NULL,'{}',?,?,'{}','owner',?,'active',1)",
  );
}

export function seedCuratedEvent(db) {
  return db.prepare("INSERT INTO curated_revision_events VALUES (?,1,'authored','{}',?,'owner')");
}

export function seedReconciliation(db) {
  return db.prepare(
    "INSERT INTO reconciliation_operations(id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff) VALUES (?,?,'preparing',?,?,'{}',0,0,0)",
  );
}

export function seedCheckpoint(db) {
  return db.prepare("INSERT INTO reconciliation_checkpoints VALUES (?,'product_reduction:one-piece',0,'{}',?)");
}

export function seedFreshness(db) {
  return db.prepare("INSERT INTO source_freshness VALUES ('one-piece','errata','','',?,'riftbound_migration_run_2')");
}

export function inboundForeignKeys(db) {
  return db.prepare(
    `SELECT m.name,f.id,f."table",f."from",f."to",f.on_delete FROM sqlite_schema m,pragma_foreign_key_list(m.name) f WHERE m.type='table' AND f."table" IN ('reconciled_errata','source_freshness','curated_revisions','reconciliation_checkpoints') ORDER BY m.name,f.id`,
  );
}

export function tableRows(db, table) {
  if (!tables.has(table)) throw new Error("Unknown migration census table");
  return db.prepare(`SELECT * FROM ${table}`);
}

export function triggers(db) {
  return db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name");
}

export function seedRiftboundCheckpoint(db) {
  return db.prepare(
    "INSERT INTO reconciliation_checkpoints VALUES ('preparation_0','product_reduction:riftbound',0,'{}',?)",
  );
}

export function setRiftboundPrintingGame(db) {
  return db.prepare("UPDATE revision_printing_query SET supported_game='riftbound' WHERE printing_id='printing_0'");
}
