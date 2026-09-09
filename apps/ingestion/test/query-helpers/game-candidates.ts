export function replaceGameCandidateProvenance(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE game_candidates SET ingestion_run_id = ? WHERE id = ?");
}

export function replaceGameHeadForFence(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE game_catalogue_heads SET revision_id = ? WHERE supported_game = ?");
}
