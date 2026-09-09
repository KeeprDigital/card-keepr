import { type CatalogueStore, repositoryStatements } from "../shared";

/** The already-computed digest is accepted only with its exact sealed manifest. */
export function retainGameSemanticReceiptStatements(db: CatalogueStore, preparationId: string, digest: string) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`INSERT INTO game_candidate_semantic_receipts(candidate_id,manifest_digest,content_digest)
      SELECT id,manifest_digest,? FROM game_candidates WHERE preparation_id=? AND state='sealed'
      ON CONFLICT(candidate_id) DO NOTHING`)
      .bind(digest, preparationId),
    sql
      .prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM game_candidates c
      JOIN game_candidate_semantic_receipts r ON r.candidate_id=c.id
      WHERE c.id=? AND c.state='sealed' AND r.manifest_digest=c.manifest_digest AND r.content_digest=?)
      THEN 1 ELSE json_extract('{}','candidate_semantic_receipt_mismatch') END`)
      .bind(preparationId, digest),
  ];
}

/** The evidence pin is immutable even when a later acceptance reuses the revision. */
export function retainGamePredecessorStatement(db: CatalogueStore, candidateId: string) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO game_candidate_predecessors
    SELECT c.id,accepted.candidate_id FROM game_candidates c
    LEFT JOIN game_accepted_candidates accepted ON accepted.supported_game=c.supported_game WHERE c.id=?`)
    .bind(candidateId);
}

/** Current evidence and the latest database mutation advance with either publication outcome. */
export function acceptGameEvidenceStatements(db: CatalogueStore, publicationId: string) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`INSERT INTO game_accepted_candidates(supported_game,candidate_id)
      SELECT c.supported_game,c.id FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id
      WHERE p.id=? AND p.state='published' AND c.state='published'
      ON CONFLICT(supported_game) DO UPDATE SET candidate_id=excluded.candidate_id`)
      .bind(publicationId),
    sql
      .prepare(`INSERT INTO catalogue_acceptance_head(singleton,publication_operation_id)
      SELECT 1,id FROM game_publication_operations WHERE id=? AND state='published'
      ON CONFLICT(singleton) DO UPDATE SET publication_operation_id=excluded.publication_operation_id`)
      .bind(publicationId),
  ];
}

/** A verified backup of an older mutation at the same revision cannot open this gate. */
export function latestAcceptanceCheckpointSql(revision: "?1" | "?3") {
  return `(${revision}='catrev_spine_000' OR EXISTS(SELECT 1 FROM catalogue_backup_attempts backup
    WHERE backup.catalogue_revision_id=${revision} AND backup.state='verified'
    AND backup.d1_bookmark IS NOT NULL AND backup.manifest_sha256 IS NOT NULL
    AND (EXISTS(SELECT 1 FROM catalogue_acceptance_head head JOIN game_publication_operations accepted
      ON accepted.id=head.publication_operation_id WHERE head.singleton=1 AND accepted.state='published'
      AND accepted.resulting_revision_id=${revision} AND backup.publication_operation_id=accepted.id)
    OR (NOT EXISTS(SELECT 1 FROM catalogue_acceptance_head) AND backup.publication_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM catalogue_revisions revision WHERE revision.id=${revision} AND revision.publication_operation_id IS NULL)))))`;
}
