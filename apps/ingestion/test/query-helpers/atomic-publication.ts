import { catalogueStore } from "../../../../src/catalogue/shared";
import { publicationSwitchStatements } from "../../../../src/catalogue/reconciliation/game-publication-repository";

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
