import { type CatalogueStore, repositoryStatements } from "./catalogue-store-repository";

/** Bounded handoff to backup/recovery: exact durable identities and four game roots. */
export function publicationBackupReservationStatement(db: CatalogueStore, attemptId: string) {
  return repositoryStatements(db)
    .prepare(`SELECT b.idempotency_key AS backup_attempt_id,b.publication_operation_id,
 b.catalogue_revision_id,b.publication_ingestion_run_id AS ingestion_run_id,b.state,b.linked_attempt_id,
 r.content_digest AS composition_digest,p.candidate_id,c.preparation_id,p.manifest_digest,p.deadline
 FROM catalogue_backup_attempts b JOIN catalogue_revisions r ON r.id=b.catalogue_revision_id
 JOIN game_publication_operations p ON p.id=b.publication_operation_id
 JOIN game_candidates c ON c.id=p.candidate_id WHERE b.idempotency_key=?`)
    .bind(attemptId);
}
export function publishedCompositionStatement(db: CatalogueStore, revisionId: string) {
  return repositoryStatements(db)
    .prepare(`SELECT m.supported_game,m.game_revision_id,m.candidate_id,m.root_digest,
 c.preparation_id,c.ingestion_run_id,c.manifest_digest
 FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
 WHERE m.catalogue_revision_id=? ORDER BY m.supported_game LIMIT 4`)
    .bind(revisionId);
}
