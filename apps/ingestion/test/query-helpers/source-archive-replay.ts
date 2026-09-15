import { repositoryStatements, type CatalogueStore } from "../../../../src/catalogue/shared";

export function archiveReplayRows(db: CatalogueStore) {
  const statements = repositoryStatements(db);
  return {
    operations: statements.prepare("SELECT * FROM source_parse_operations WHERE source_snapshot_id=? ORDER BY id"),
    sets: statements.prepare("SELECT * FROM source_observation_sets WHERE source_snapshot_id=? ORDER BY id"),
    records: statements.prepare("SELECT * FROM source_record_pages WHERE observation_set_id=? ORDER BY ordinal"),
    auxiliary: statements.prepare(
      "SELECT * FROM source_record_auxiliary WHERE observation_set_id=? ORDER BY kind,record_key,ordinal",
    ),
  };
}

export function archiveReplayRequests(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT * FROM source_requests WHERE ingestion_run_id=? ORDER BY sequence_number",
  );
}

export function archiveReplayReservation(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT active_ingestion_run_id FROM operation_state WHERE singleton=1");
}
