import { catalogueStore, atomicRepositoryStatement } from "../../../../src/catalogue/shared";
import { guardRevisionLegalityRulesStatement } from "../../../../src/catalogue/legality/legality-guard-repository";
export async function disableLegalityPublicationTriggers(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare("DROP TRIGGER IF EXISTS legality_rule_card_ids_canonical_insert"),
    database.prepare("DROP TRIGGER IF EXISTS legality_rule_effect_valid_insert"),
    database.prepare("DROP TRIGGER IF EXISTS legality_rule_scope_valid_insert"),
    database.prepare("DROP TRIGGER IF EXISTS legality_rule_provenance_owner_insert"),
    database.prepare("DROP TRIGGER IF EXISTS legality_rule_provenance_owner_update"),
    database.prepare("DROP TRIGGER IF EXISTS retain_legality_rule_evidence"),
    database.prepare("DROP TRIGGER IF EXISTS revision_legality_rule_effect_valid_insert"),
    database.prepare("DROP TRIGGER IF EXISTS revision_legality_rule_scope_valid_insert"),
    database.prepare("DROP TRIGGER IF EXISTS revision_legality_rule_matches_canonical"),
    database.prepare("DROP TRIGGER IF EXISTS revision_legality_rule_evidence_projected"),
    database.prepare("DROP TRIGGER IF EXISTS revision_legality_rule_applicability_insert"),
  ]);
}

export function storedLegalityRule(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT * FROM legality_rules WHERE id = ?");
}

export function storedLegalityProjection(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT * FROM revision_legality_rules WHERE catalogue_revision_id = ? AND legality_rule_id = ?",
  );
}

export function storedLegalityEvidence(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "SELECT source_observation_id, retained_by_table, retained_record_id FROM retained_source_observation_evidence WHERE source_observation_id = ?",
  );
}

export function storedLegalityApplicability(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT applicability_kind, card_id FROM revision_legality_rule_applicability
    WHERE catalogue_revision_id = ? AND legality_rule_id = ? ORDER BY applicability_kind, card_id`);
}

export function insertLegalityProjectionWithoutRetrievedAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_legality_rules (
    catalogue_revision_id, legality_rule_id, supported_game, region, format,
    event_tier, effective_from, effective_until, unresolved_scope_json,
    card_ids_json, source_retrieved_at, document_json
  ) SELECT ?, id, supported_game, region, format, event_tier, effective_from,
      effective_until, unresolved_scope_json, card_ids_json, NULL, ?
    FROM legality_rules WHERE id = ?`);
}

// Deliberately malformed persisted rows exercise guards for corruption shapes
// which the publication factory's canonical-column projection cannot construct.
export function insertCheckedLegalityProjectionFixture(
  database: D1Database,
  input: Readonly<{
    revisionId: string;
    id: string | number | null | undefined;
    game: string | number | null | undefined;
    region: string | number | null | undefined;
    format: string | number | null | undefined;
    eventTier: string | number | null | undefined;
    effectiveFrom: string | number | null | undefined;
    effectiveUntil: string | number | null | undefined;
    cardIdsJson: string | number | null | undefined;
    documentJson: string | number | null | undefined;
  }>,
): D1PreparedStatement {
  const store = catalogueStore(database);
  return atomicRepositoryStatement(store, {
    statement: database
      .prepare(`INSERT INTO revision_legality_rules (
      catalogue_revision_id, legality_rule_id, supported_game, region, format,
      event_tier, effective_from, effective_until, card_ids_json, document_json,
      source_retrieved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT snapshot.retrieved_at
      FROM legality_rules AS canonical JOIN source_snapshots AS snapshot
        ON snapshot.id = canonical.source_snapshot_id WHERE canonical.id = ?))`)
      .bind(
        input.revisionId,
        input.id,
        input.game,
        input.region,
        input.format,
        input.eventTier,
        input.effectiveFrom,
        input.effectiveUntil,
        input.cardIdsJson,
        input.documentJson,
        input.id,
      ),
    after: [
      guardRevisionLegalityRulesStatement(store, {
        revisionId: input.revisionId,
        payload: JSON.stringify([{ id: input.id }]),
      }),
    ],
  });
}

export async function seedLegalityProjectionGuardTarget(database: D1Database): Promise<void> {
  await database.batch([
    database.prepare(`INSERT INTO ingestion_runs
      (id, state, selected_games_json, started_at, expected_current_revision_id, idempotency_key, candidate_json)
      VALUES ('run_projection_guard_target', 'planning', '["one-piece"]',
        '2026-01-01T00:00:00.000Z', 'catrev_spine_000', 'projection-guard-target', '{}')`),
    database.prepare(`INSERT INTO catalogue_revisions
      (id, ingestion_run_id, published_at, content_digest, expected_previous_revision_id, approved_candidate_digest)
      VALUES ('catrev_projection_guard_target', 'run_projection_guard_target',
        '2026-01-01T00:00:00.000Z', 'fixture-target', 'catrev_spine_000', 'fixture-target')`),
  ]);
}
