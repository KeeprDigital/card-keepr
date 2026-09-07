export function retainLegacyAdmissionPin(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO entity_admission_run_pins
    (ingestion_run_id, games_json, policy_json) VALUES (?, '["one-piece"]', ?)`);
}

export function retainLegacyAdmissionSelection(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO entity_admission_pinned_decisions
    (ingestion_run_id, proposal_id, generation) VALUES (?, ?, 0)`);
}

export function retainLegacyCorrectionPin(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO identity_correction_run_pins
    (ingestion_run_id, games_json, decision_cutoff) VALUES (?, '["one-piece"]', 0)`);
}
