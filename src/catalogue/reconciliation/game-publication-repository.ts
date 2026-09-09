import { acceptGameEvidenceStatements, latestAcceptanceCheckpointSql } from "./game-publication-no-change-repository";
import { type CatalogueStore, repositoryStatements } from "../shared";

export function retainPublicPackageManifest(
  db: CatalogueStore,
  id: string,
  generation: number,
  digest: string,
  key: string,
) {
  return repositoryStatements(db)
    .prepare(
      "INSERT INTO game_publication_actions SELECT ?,id,?,? FROM game_publication_operations WHERE id=? AND generation=? AND state IN ('approved','waiting_artifacts','waiting_backup') AND julianday(deadline)>julianday('now') ON CONFLICT(idempotency_key) DO NOTHING",
    )
    .bind(
      `public-package:${id}:${digest}`,
      JSON.stringify({ contract: "public-package@1" }),
      JSON.stringify({ sha256: digest, object_key: key }),
      id,
      generation,
    );
}

export function publicationOperationStatement(db: CatalogueStore, id: string, byKey = false) {
  return repositoryStatements(db)
    .prepare(`SELECT p.*, c.preparation_id,c.ingestion_run_id,c.supported_game
    FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id
    WHERE p.${byKey ? "idempotency_key" : "id"}=?`)
    .bind(id);
}
export function retainPublicationApproval(
  db: CatalogueStore,
  input: {
    id: string;
    candidate: string;
    manifest: string;
    predecessor: string;
    generation: number;
    deadline: string;
    at: string;
    receipt: string;
    key: string;
    request: string;
    approval: string;
  },
) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO game_publication_operations
 (id,candidate_id,manifest_digest,expected_game_revision_id,candidate_generation,deadline,approved_at,
 inspection_receipt,idempotency_key,request_json,approval_json,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,'approved')`)
    .bind(
      input.id,
      input.candidate,
      input.manifest,
      input.predecessor,
      input.generation,
      input.deadline,
      input.at,
      input.receipt,
      input.key,
      input.request,
      input.approval,
    );
}

export function publicationCompositionHead(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT current_revision_id FROM catalogue_state WHERE singleton=1`);
}
export function compositionGamesStatement(db: CatalogueStore, revision: string) {
  return repositoryStatements(db)
    .prepare(`SELECT supported_game,candidate_id,game_revision_id,root_digest
 FROM catalogue_composition_games WHERE catalogue_revision_id=? ORDER BY supported_game LIMIT 5`)
    .bind(revision);
}
export function publicationCheckpointStatement(db: CatalogueStore, revision: string) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE WHEN ${latestAcceptanceCheckpointSql("?1")} THEN 1 ELSE 0 END AS ready`)
    .bind(revision);
}
export function updatePublicationState(
  db: CatalogueStore,
  id: string,
  generation: number,
  state: string,
  code: string | null = null,
) {
  return repositoryStatements(db)
    .prepare(`UPDATE game_publication_operations SET state=?,failure_code=?
 WHERE id=? AND generation=? AND state IN ('approved','waiting_artifacts','waiting_backup')`)
    .bind(state, code, id, generation);
}
export function pausePublicationSuccessor(
  db: CatalogueStore,
  id: string,
  generation: number,
  shard: number,
  sequence: number,
) {
  const next = `public-export-attempt:${id}:${generation}:${shard + 1}:`;
  return repositoryStatements(db)
    .prepare(`UPDATE game_publication_operations SET state='retry_paused',failure_code='publication_successor_dispatch_exhausted'
 WHERE id=? AND generation=? AND state IN ('approved','waiting_artifacts','waiting_backup')
 AND coalesce((SELECT sequence FROM publication_export_preparations WHERE publication_operation_id=?),0)=?
 AND NOT EXISTS(SELECT 1 FROM game_publication_actions WHERE idempotency_key>=? AND idempotency_key<?)`)
    .bind(id, generation, id, sequence, next, `${next}~`);
}
export function publicationSwitchGuard(
  db: CatalogueStore,
  input: {
    id: string;
    generation: number;
    predecessor: string;
    composition: string;
    at: string;
    clockOffsetMs?: number;
  },
) {
  return repositoryStatements(db)
    .prepare(`SELECT CASE
 WHEN NOT EXISTS (SELECT 1 FROM game_publication_operations WHERE id=?1 AND generation=?2
 AND state IN ('approved','waiting_artifacts','waiting_backup')) THEN json_extract('{}','publication_writer_conflict')
 WHEN EXISTS (SELECT 1 FROM game_publication_operations WHERE id=?1 AND julianday(deadline)<=julianday('now')+?6/86400000.0) THEN json_extract('{}','publication_deadline_expired')
 WHEN NOT EXISTS (SELECT 1 FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id
 JOIN reconciliation_operations o ON o.id=c.preparation_id
 JOIN game_candidate_slots slot ON slot.supported_game=c.supported_game AND slot.preparation_id=c.preparation_id
 JOIN game_catalogue_heads h ON h.supported_game=c.supported_game AND h.revision_id=p.expected_game_revision_id
 JOIN publication_preparations a ON a.candidate_id=c.id AND a.manifest_digest=p.manifest_digest AND a.generation=p.candidate_generation AND a.state='verified'
 JOIN publication_export_preparations public ON public.candidate_id=c.id AND public.publication_operation_id=p.id AND public.state='verified' AND public.root_digest IS NOT NULL AND public.revision_id='catrev_' || substr(p.id,13)
 JOIN game_candidate_partitions summary ON summary.candidate_id=c.id AND summary.ordinal=c.partition_count-1 AND summary.kind='inspection_summary'
 WHERE p.id=?1 AND c.state='sealed' AND o.state='sealed' AND c.generation=p.candidate_generation AND o.generation=p.candidate_generation
 AND c.manifest_digest=p.manifest_digest AND c.deadline=p.deadline AND c.expected_game_revision_id=p.expected_game_revision_id
 AND EXISTS (SELECT 1 FROM publication_read_entities metadata WHERE metadata.candidate_id=c.id AND metadata.kind='supported_games')
 AND json_extract(summary.content,'$[0].value.integrity.complete')=1
 AND json_extract(summary.content,'$[0].value.integrity.sha256')=p.inspection_receipt)
 THEN json_extract('{}','publication_candidate_conflict')
 WHEN NOT EXISTS (SELECT 1 FROM operation_state WHERE singleton=1 AND recovery_health='healthy'
 AND active_recovery_id IS NULL AND recovery_restore_guard='clear' AND active_production_release_id IS NULL)
 THEN json_extract('{}','recovery_not_verified')
 WHEN (SELECT current_revision_id FROM catalogue_state WHERE singleton=1)<>?3 THEN json_extract('{}','publication_composition_conflict')
 WHEN ?3<>'catrev_spine_000' AND NOT EXISTS(SELECT 1 FROM catalogue_composition_games WHERE catalogue_revision_id=?3)
 THEN json_extract('{}','publication_legacy_composition_unprepared')
 WHEN NOT ${latestAcceptanceCheckpointSql("?3")} THEN json_extract('{}','publication_backup_pending')
 WHEN NOT EXISTS(SELECT 1 FROM verified_publication_compositions WHERE sha256=?4)
 THEN json_extract('{}','publication_composition_unverified')
 WHEN NOT EXISTS(SELECT 1 FROM game_publication_actions a WHERE a.publication_operation_id=?1
 AND a.idempotency_key='public-package:' || ?1 || ':' || ?4 AND json_extract(a.result_json,'$.sha256')=?4
 AND json_extract(a.result_json,'$.object_key')='catalogue-public-manifests/catrev_' || substr(?1,13) || '/' || ?4 || '.json')
 THEN json_extract('{}','publication_package_unverified')
 WHEN EXISTS (
 WITH expected AS (
 SELECT old.supported_game,old.candidate_id,old.root_digest,public.root_digest AS public_root_digest FROM catalogue_composition_games old JOIN publication_export_preparations public ON public.candidate_id=old.candidate_id AND public.state='verified'
 WHERE old.catalogue_revision_id=?3 AND old.supported_game<>(SELECT c.supported_game FROM game_candidates c JOIN game_publication_operations p ON p.candidate_id=c.id WHERE p.id=?1)
 UNION ALL SELECT c.supported_game,c.id,a.root_digest,public.root_digest FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id
 JOIN publication_preparations a ON a.candidate_id=c.id JOIN publication_export_preparations public ON public.candidate_id=c.id AND public.state='verified' WHERE p.id=?1
 ), actual AS (SELECT json_extract(value,'$.supported_game') supported_game,json_extract(value,'$.candidate_id') candidate_id,json_extract(value,'$.root_digest') root_digest,json_extract(value,'$.public_root_digest') public_root_digest
 FROM verified_publication_compositions,json_each(content,'$.games') WHERE sha256=?4)
 SELECT * FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual)
 UNION ALL SELECT * FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected)
 ) THEN json_extract('{}','publication_composition_conflict') ELSE 1 END`)
    .bind(input.id, input.generation, input.predecessor, input.composition, input.at, input.clockOffsetMs ?? 0);
}

/** Five members and fixed metadata only. No entity rows enter this transaction. */
export function publicationSwitchStatements(
  db: CatalogueStore,
  input: {
    id: string;
    generation: number;
    predecessor: string;
    composition: string;
    at: string;
    clockOffsetMs?: number;
    revision: string;
    backup: string;
  },
) {
  const sql = repositoryStatements(db);
  return [
    publicationSwitchGuard(db, input),
    sql
      .prepare(`INSERT INTO catalogue_revisions(id,ingestion_run_id,published_at,content_digest,expected_previous_revision_id,approved_candidate_digest,publication_operation_id)
 SELECT ?,c.ingestion_run_id,?,?,?,p.manifest_digest,p.id FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id WHERE p.id=?`)
      .bind(input.revision, input.at, input.composition, input.predecessor, input.id),
    sql
      .prepare(
        `INSERT INTO catalogue_candidate_publications SELECT candidate_id,? FROM game_publication_operations WHERE id=?`,
      )
      .bind(input.revision, input.id),
    sql
      .prepare(
        "INSERT INTO catalogue_exports(catalogue_revision_id,manifest_key,manifest_digest,verified) VALUES (?, ?, ?,1)",
      )
      .bind(
        input.revision,
        `catalogue-public-manifests/${input.revision}/${input.composition}.json`,
        input.composition,
      ),
    sql
      .prepare(`INSERT INTO catalogue_composition_games SELECT ?,json_extract(value,'$.supported_game'),json_extract(value,'$.candidate_id'),
 CASE WHEN json_extract(value,'$.candidate_id')=(SELECT candidate_id FROM game_publication_operations WHERE id=?) THEN ? ELSE
 (SELECT game_revision_id FROM catalogue_composition_games WHERE catalogue_revision_id=? AND supported_game=json_extract(value,'$.supported_game')) END,
 json_extract(value,'$.root_digest') FROM verified_publication_compositions,json_each(content,'$.games') WHERE sha256=?`)
      .bind(input.revision, input.id, input.revision, input.predecessor, input.composition),
    sql
      .prepare(
        `UPDATE game_catalogue_heads SET revision_id=? WHERE supported_game=(SELECT c.supported_game FROM game_candidates c JOIN game_publication_operations p ON p.candidate_id=c.id WHERE p.id=?)`,
      )
      .bind(input.revision, input.id),
    sql
      .prepare(`UPDATE catalogue_state SET current_revision_id=?,published_at=? WHERE singleton=1`)
      .bind(input.revision, input.at),
    sql
      .prepare(`INSERT INTO catalogue_query_revisions(catalogue_revision_id,state) VALUES (?,'available')`)
      .bind(input.revision),
    sql
      .prepare(`WITH RECURSIVE retained(id,depth) AS (SELECT ?,0 UNION ALL SELECT r.expected_previous_revision_id,depth+1 FROM catalogue_revisions r JOIN retained ON retained.id=r.id WHERE depth<2)
 UPDATE catalogue_query_revisions SET state='archived' WHERE catalogue_revision_id NOT IN (SELECT id FROM retained)`)
      .bind(input.revision),
    sql
      .prepare(`INSERT INTO catalogue_backup_attempts(idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,started_at,publication_ingestion_run_id,publication_operation_id)
 SELECT ?,json_object('publication_operation_id',p.id,'catalogue_revision_id',?,'composition_digest',?),?,?, 'pending',?,?,c.ingestion_run_id,p.id
 FROM game_publication_operations p JOIN game_candidates c ON c.id=p.candidate_id WHERE p.id=?`)
      .bind(
        input.backup,
        input.revision,
        input.composition,
        input.backup,
        input.revision,
        `catalogue-backups/${input.backup}`,
        input.at,
        input.id,
      ),
    sql
      .prepare(
        `UPDATE game_candidates SET state='published' WHERE id=(SELECT candidate_id FROM game_publication_operations WHERE id=?)`,
      )
      .bind(input.id),
    sql
      .prepare(
        `DELETE FROM game_candidate_slots WHERE preparation_id=(SELECT c.preparation_id FROM game_candidates c JOIN game_publication_operations p ON p.candidate_id=c.id WHERE p.id=?)`,
      )
      .bind(input.id),
    sql
      .prepare(
        `UPDATE game_publication_operations SET state='published',failure_code=NULL,resulting_revision_id=?,backup_attempt_id=?,published_at=? WHERE id=? AND generation=?`,
      )
      .bind(input.revision, input.backup, input.at, input.id, input.generation),
    ...acceptGameEvidenceStatements(db, input.id),
  ];
}

export function publicationResumeAction(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`SELECT request_json,result_json FROM game_publication_actions WHERE idempotency_key=?`)
    .bind(key);
}
export function publicationResumeStatements(
  db: CatalogueStore,
  id: string,
  generation: number,
  key: string,
  request: string,
  result: string,
  at: string,
) {
  const sql = repositoryStatements(db);
  return [
    sql
      .prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM game_publication_operations p,operation_state o
 WHERE p.id=? AND p.generation=? AND p.state NOT IN ('published','failed') AND p.deadline>?
 AND o.singleton=1 AND o.recovery_health='healthy' AND o.active_recovery_id IS NULL AND o.recovery_restore_guard='clear')
 THEN 1 ELSE json_extract('{}','publication_resume_conflict') END`)
      .bind(id, generation, at),
    sql
      .prepare(
        `UPDATE game_publication_operations SET generation=generation+1,state='approved',failure_code=NULL WHERE id=?`,
      )
      .bind(id),
    sql.prepare(`INSERT INTO game_publication_actions VALUES (?,?,?,?)`).bind(key, id, request, result),
  ];
}

export function publicExportPreparationStatement(db: CatalogueStore, candidate: string) {
  return repositoryStatements(db)
    .prepare(
      "SELECT state,root_digest,root_object_key,root_bytes,failure_code FROM publication_export_preparations WHERE candidate_id=?",
    )
    .bind(candidate);
}
