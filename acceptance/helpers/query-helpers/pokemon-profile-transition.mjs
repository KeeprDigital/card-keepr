export function candidateDefinition(database) {
  return database.prepare(`SELECT candidate.id,candidate.ingestion_run_id,candidate.state,candidate.generation,
    candidate.manifest_digest,operation.definition_pins_json
    FROM game_candidates candidate JOIN reconciliation_operations operation ON operation.id=candidate.preparation_id
    WHERE candidate.id=?`);
}

export function immutablePokemonHistory(database) {
  return [
    ["admission", database.prepare("SELECT * FROM entity_admission_decisions ORDER BY proposal_id,generation")],
    ["observations", database.prepare("SELECT * FROM source_observation_sets ORDER BY id")],
    ["snapshots", database.prepare("SELECT * FROM source_snapshots ORDER BY id")],
    [
      "published_exports",
      database.prepare("SELECT * FROM publication_export_components ORDER BY candidate_id,ordinal"),
    ],
  ].map(([kind, statement]) => ({ kind, rows: statement.all() }));
}

export function pokemonExportReceipts(database) {
  return database.prepare(`SELECT preparations.revision_id,components.kind,components.object_key,components.sha256,
    components.byte_length,components.descriptor_json
    FROM publication_export_components components
    JOIN publication_export_preparations preparations ON preparations.candidate_id=components.candidate_id
    ORDER BY preparations.revision_id,components.ordinal`);
}

export function foreignKeyViolations(database) {
  return database.prepare("PRAGMA foreign_key_check");
}
