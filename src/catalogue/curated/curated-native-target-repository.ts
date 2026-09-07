import { type CatalogueStore, repositoryStatements } from "../shared";

export function curatedNativeRevisionStatement(db: CatalogueStore, revision: string) {
  return repositoryStatements(db)
    .prepare(`SELECT r.publication_operation_id,q.state AS query_state
    FROM catalogue_revisions r LEFT JOIN catalogue_query_revisions q ON q.catalogue_revision_id=r.id
    WHERE r.id=?`)
    .bind(revision);
}
export function curatedNativeMemberStatement(db: CatalogueStore, revision: string, kind: string, id: string) {
  return repositoryStatements(db)
    .prepare(`SELECT c.preparation_id,m.supported_game,e.card_id
    FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
    JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
    WHERE m.catalogue_revision_id=? AND e.kind=? AND e.entity_id=?
      AND c.state='published' AND c.supported_game=m.supported_game LIMIT 1`)
    .bind(revision, kind, id);
}
export function curatedNativeCheckpointStatement(db: CatalogueStore, preparation: string, phase: string) {
  return repositoryStatements(db)
    .prepare(`SELECT content,sha256 FROM reconciliation_checkpoints
    WHERE preparation_id=? AND phase=? ORDER BY ordinal DESC LIMIT 1`)
    .bind(preparation, phase);
}
export function curatedNativeEntityStatement(
  db: CatalogueStore,
  preparation: string,
  namespace: string,
  key: string,
  through: number,
) {
  return repositoryStatements(db)
    .prepare(`SELECT content,sha256 FROM reconciliation_reducer_state
    WHERE preparation_id=? AND namespace=? AND key_digest=? AND observation_ordinal<=?
    ORDER BY observation_ordinal DESC LIMIT 1`)
    .bind(preparation, namespace, key, through);
}
export function curatedNativeTextStatement(db: CatalogueStore, preparation: string, digest: string, ordinal: number) {
  return repositoryStatements(db)
    .prepare(`SELECT content FROM reconciliation_text_chunks
    WHERE preparation_id=? AND sha256=? AND ordinal=?`)
    .bind(preparation, digest, ordinal);
}

export function curatedNativeCorrectionPinStatement(db: CatalogueStore, preparation: string) {
  return repositoryStatements(db)
    .prepare(`SELECT decision_cutoff,games_json FROM reconciliation_correction_pins WHERE preparation_id=?`)
    .bind(preparation);
}
