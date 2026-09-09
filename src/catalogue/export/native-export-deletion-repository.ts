import { type CatalogueStore, repositoryStatements } from "../shared";

export function nativeDeletionComposition(db: CatalogueStore, revision: string) {
  return repositoryStatements(db)
    .prepare(`SELECT r.content_digest,v.content,
 (SELECT b.idempotency_key FROM catalogue_backup_attempts b JOIN catalogue_revisions backed ON backed.id=b.catalogue_revision_id
 WHERE b.state='verified' AND b.manifest_sha256 IS NOT NULL AND backed.publication_operation_id IS NOT NULL
 AND b.started_at>=r.published_at ORDER BY b.started_at DESC LIMIT 1) AS retained_backup
 FROM catalogue_revisions r JOIN verified_publication_compositions v ON v.sha256=r.content_digest
 WHERE r.id=? AND r.publication_operation_id IS NOT NULL`)
    .bind(revision);
}
export function nativeDeletionPublicRoots(db: CatalogueStore, revision: string) {
  return repositoryStatements(db)
    .prepare(`SELECT m.supported_game,m.candidate_id,p.root_digest,p.root_object_key,p.root_bytes
 FROM catalogue_composition_games m JOIN publication_export_preparations p ON p.candidate_id=m.candidate_id AND p.state='verified'
 WHERE m.catalogue_revision_id=? ORDER BY m.supported_game LIMIT 5`)
    .bind(revision);
}
