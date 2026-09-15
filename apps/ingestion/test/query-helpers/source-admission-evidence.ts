import { type CatalogueStore, repositoryStatements } from "../../../../src/catalogue/shared";

export function insertReviewPreparation(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO reconciliation_operations
    (id,ingestion_run_id,supported_game,state,created_at,deadline,definition_pins_json,
     observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
}
export function insertReviewSlot(db: CatalogueStore) {
  return repositoryStatements(db).prepare("INSERT INTO game_candidate_slots VALUES (?,?,?)");
}
export function abandonReviewPreparation(db: CatalogueStore) {
  return repositoryStatements(db).prepare("UPDATE reconciliation_operations SET state=? WHERE id=?");
}
export function releaseReviewSlot(db: CatalogueStore) {
  return repositoryStatements(db).prepare("DELETE FROM game_candidate_slots WHERE preparation_id=?");
}
export function reviewImageSnapshots(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT snapshot.* FROM source_snapshots snapshot
    JOIN source_requests request ON request.ingestion_run_id=snapshot.ingestion_run_id AND request.request_id=snapshot.request_id
    WHERE snapshot.ingestion_run_id=? AND request.request_role=? ORDER BY snapshot.request_url`);
}
export function reviewProposals(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT * FROM entity_proposals WHERE source_lineage=? ORDER BY reference");
}
export function reviewEvidencePins(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT * FROM entity_proposal_source_evidence WHERE ingestion_run_id=? ORDER BY proposal_id",
  );
}
export function reviewPrivateReferences(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT object_key FROM evidence_object_references WHERE owner_kind=? AND owner_id=? ORDER BY object_key",
  );
}
export function reviewAllocations(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT * FROM canonical_identity_allocations ORDER BY allocation_key");
}
export function releaseReviewCollection(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "UPDATE operation_state SET active_ingestion_run_id=NULL WHERE active_ingestion_run_id=?",
  );
}
