import { catalogueStore } from "../../../../src/catalogue/shared";
import { publicationSwitchStatements } from "../../../../src/catalogue/reconciliation/game-publication-repository";

export function publicComponents(db: D1Database, candidate: string) {
  return db
    .prepare(
      "SELECT kind,entity_id,input_digest,object_key,sha256,byte_length FROM publication_export_components WHERE candidate_id=? ORDER BY kind,entity_id",
    )
    .bind(candidate)
    .all<{
      kind: string;
      entity_id: string;
      input_digest: string;
      object_key: string;
      sha256: string;
      byte_length: number;
    }>();
}

// Failure injection at the database transaction boundary: a sibling write before
// the production guard must roll back with every failed switch predicate.
export async function rejectedAtomicSwitch(db: D1Database, input: Parameters<typeof publicationSwitchStatements>[1]) {
  const store = catalogueStore(db);
  return store.batch([
    db.prepare("UPDATE catalogue_state SET published_at='injected-sibling' WHERE singleton=1"),
    ...publicationSwitchStatements(store, input),
  ]);
}
export function publicationStateSnapshot(db: D1Database) {
  return db
    .prepare(`SELECT current_revision_id,published_at,
    (SELECT count(*) FROM catalogue_revisions) AS revisions,
    (SELECT count(*) FROM catalogue_composition_games) AS members,
    (SELECT count(*) FROM catalogue_backup_attempts) AS backups,
    (SELECT count(*) FROM game_publication_operations WHERE state='published') AS results
    FROM catalogue_state WHERE singleton=1`)
    .first();
}

// Synthetic checkpoint admission only. This is not a backup/restore verification
// proof; issue229 exercises actual exported SQL and independent restoration.
export function admitSyntheticCurrentCheckpoint(db: D1Database) {
  return db
    .prepare(`UPDATE catalogue_backup_attempts SET state='verified',d1_bookmark='synthetic-guard-test',completed_at='2026-09-01T00:00:00.000Z',manifest_sha256=?
    WHERE catalogue_revision_id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1)`)
    .bind("f".repeat(64))
    .run();
}
export function currentGameMembers(db: D1Database) {
  return db
    .prepare(`SELECT m.supported_game,m.candidate_id,m.game_revision_id,
 (SELECT group_concat(entity_id) FROM (SELECT entity_id FROM publication_read_entities e WHERE e.candidate_id=m.candidate_id AND e.kind='cards' ORDER BY entity_id)) card_ids
 FROM catalogue_composition_games m WHERE m.catalogue_revision_id=(SELECT current_revision_id FROM catalogue_state WHERE singleton=1) ORDER BY m.supported_game`)
    .all<{ supported_game: string; candidate_id: string; game_revision_id: string; card_ids: string }>();
}

export async function installLegacyCurrentHead(db: D1Database, sourceId: string) {
  await db.batch([
    db
      .prepare(
        `INSERT INTO catalogue_revisions(id,ingestion_run_id,content_digest,expected_previous_revision_id,published_at,approved_candidate_digest) VALUES ('catrev_legacy_guard',? ,?,'catrev_spine_000','2026-09-01T00:00:00.000Z',?)`,
      )
      .bind(sourceId, "e".repeat(64), "e".repeat(64)),
    db.prepare(`UPDATE catalogue_state SET current_revision_id='catrev_legacy_guard' WHERE singleton=1`),
  ]);
}
export function restoreFixtureSpine(db: D1Database) {
  return db.prepare(`UPDATE catalogue_state SET current_revision_id='catrev_spine_000' WHERE singleton=1`).run();
}
