import { catalogueStore } from "../../../../src/catalogue/shared";
import { unchangedPublicationStatements } from "../../../../src/catalogue/reconciliation/game-publication-repository";

export function nativeNoChangeState(db: D1Database) {
  return db
    .prepare(`SELECT state.current_revision_id,state.published_at,revision.content_digest,
    (SELECT count(*) FROM catalogue_revisions) AS revisions,
    (SELECT count(*) FROM catalogue_exports) AS exports,
    (SELECT candidate_id FROM game_accepted_candidates WHERE supported_game='one-piece') AS accepted_candidate,
    (SELECT publication_operation_id FROM catalogue_acceptance_head WHERE singleton=1) AS acceptance_operation,
    (SELECT revision_id FROM game_catalogue_heads WHERE supported_game='one-piece') AS game_revision,
    (SELECT json_group_array(json_object('revision',catalogue_revision_id,'state',state))
      FROM (SELECT * FROM catalogue_query_revisions ORDER BY catalogue_revision_id)) AS query_window
    FROM catalogue_state state JOIN catalogue_revisions revision ON revision.id=state.current_revision_id WHERE state.singleton=1`)
    .first<{
      current_revision_id: string;
      published_at: string;
      content_digest: string;
      revisions: number;
      exports: number;
      accepted_candidate: string;
      acceptance_operation: string;
      game_revision: string;
      query_window: string;
    }>();
}

export function acceptedPrivateRoot(db: D1Database, candidate: string) {
  return db
    .prepare("SELECT root_digest FROM publication_preparations WHERE candidate_id=? AND state='verified'")
    .bind(candidate)
    .first<string>("root_digest");
}

export function nativeBackupIdentity(db: D1Database, id: string) {
  return db
    .prepare(`SELECT publication_operation_id,publication_reserved,linked_attempt_id,state
    FROM catalogue_backup_attempts WHERE idempotency_key=?`)
    .bind(id)
    .first();
}

export function nativeCandidatePredecessor(db: D1Database, candidate: string) {
  return db
    .prepare("SELECT predecessor_candidate_id FROM game_candidate_predecessors WHERE candidate_id=?")
    .bind(candidate)
    .first<string>("predecessor_candidate_id");
}

/** The sibling write must roll back with every final-guard rejection. */
export function rejectedUnchangedPublication(
  db: D1Database,
  input: Parameters<typeof unchangedPublicationStatements>[1],
) {
  return catalogueStore(db).batch([
    db.prepare("UPDATE catalogue_state SET published_at='injected-sibling' WHERE singleton=1"),
    ...unchangedPublicationStatements(catalogueStore(db), input),
  ]);
}
