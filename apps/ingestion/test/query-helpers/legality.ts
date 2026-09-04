// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function dropRevisionLegalityRulesImmutableUpdate(database: D1Database): D1PreparedStatement {
  return database.prepare("DROP TRIGGER revision_legality_rules_immutable_update");
}

export function setRevisionLegalityRulesDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE revision_legality_rules
     SET document_json = '{"attacker":"malformed"}'
     WHERE catalogue_revision_id = ?
       AND legality_rule_id <> ?`);
}

export function createRevisionLegalityRulesImmutableUpdate(database: D1Database): D1PreparedStatement {
  return database.prepare(`CREATE TRIGGER revision_legality_rules_immutable_update
     BEFORE UPDATE ON revision_legality_rules
     BEGIN
       SELECT RAISE(ABORT, 'revision_legality_rule_immutable');
     END`);
}

export function setRevisionLegalityRulesDocumentJsonForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE revision_legality_rules SET document_json = ?
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`);
}

export function readRevisionLegalityRuleApplicabilityApplicabilityKindCardId(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT applicability_kind, card_id
     FROM revision_legality_rule_applicability
     WHERE catalogue_revision_id = ? AND legality_rule_id = ?
     ORDER BY applicability_kind`);
}

export function inspectForeignKeyList(database: D1Database): D1PreparedStatement {
  return database.prepare(`PRAGMA foreign_key_list(revision_legality_rules)`);
}

export function readSqliteMasterName(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT name FROM sqlite_master
     WHERE type = 'trigger' AND name IN (
       'guard_legality_rule_identity',
       'legality_rule_card_ids_canonical_insert',
       'legality_rule_card_ids_canonical_update',
       'legality_rule_provenance_owner_insert',
       'legality_rule_provenance_owner_update',
       'legality_rule_provenance_immutable',
       'legality_rule_scope_valid_insert',
       'legality_rules_immutable_delete',
       'revision_legality_rule_matches_canonical',
       'revision_legality_rule_scope_valid_insert',
       'revision_legality_rules_immutable_delete',
       'revision_legality_rules_immutable_update'
     ) ORDER BY name`);
}

export function setRevisionLegalityRulesFormat(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE revision_legality_rules SET format = 'attacker-format'
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`);
}

export function deleteRevisionLegalityRules(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = 'catrev_upgraded_legality_guard'
         AND legality_rule_id = ?`);
}

export function insertRevisionLegalityRulesForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRuleWithCatrevUpgradedLegalityGuard(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_upgraded_legality_guard', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
}

export function readRevisionLegalityRulesDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT document_json
     FROM revision_legality_rules
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.official_id') = ?`);
}

export function readLegalityRulesId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id FROM legality_rules ORDER BY id LIMIT 3`);
}

export function setLegalityRulesId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE legality_rules SET id = ? WHERE id = ?`);
}

export function setLegalityRulesFirstRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE legality_rules SET first_revision_id = ? WHERE id = ?`);
}

export function deleteLegalityRules(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM legality_rules WHERE id = ?`);
}

export function insertRevisionLegalityRulesForTestOwnedDomainEvidencePublishesExactLegalityRulesKeeps(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES (?, 'legality_rule_missing_canonical', 'gundam',
         'EN-ASIA', 'standard', NULL, '2026-01-01', NULL, '[]', ?)`);
}

export function readLegalityRulesDocumentJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT canonical.*, revision.document_json
     FROM legality_rules AS canonical
     JOIN revision_legality_rules AS revision
       ON revision.legality_rule_id = canonical.id
     WHERE revision.catalogue_revision_id = ?
       AND json_extract(canonical.effect_json, '$.type') =
       'prohibited_combination'
     ORDER BY canonical.id
     LIMIT 1`);
}

export function setRevisionLegalityRulesFormatForTestOwnedDomainEvidencePublishesExactLegalityRulesKeeps(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE revision_legality_rules
       SET format = 'attacker-format'
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`);
}

export function deleteRevisionLegalityRulesForTestOwnedDomainEvidencePublishesExactLegalityRulesKeeps(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_legality_rules
       WHERE catalogue_revision_id = ? AND legality_rule_id = ?`);
}

export function insertRevisionLegalityRulesForTestOwnedDomainEvidencePublishesExactLegalityRulesKeepsWithAttackerFormat(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, 'attacker-format', ?, ?, ?,
         ?, ?)`);
}

export function insertRevisionLegalityRulesForTestOwnedDomainEvidencePublishesExactLegalityRulesKeepsWithCatrevSpine000(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO revision_legality_rules (
         catalogue_revision_id, legality_rule_id, supported_game,
         region, format, event_tier, effective_from, effective_until,
         card_ids_json, document_json
       ) VALUES ('catrev_spine_000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
}

export function readLegalityRulesDirectCardIdsJsonCardIdsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT direct_card_ids_json, card_ids_json, effect_json
     FROM legality_rules
     WHERE official_id = ?`);
}

export function countLegalityRulesCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM legality_rules`);
}

export function readRevisionLegalityRuleApplicabilityApplicabilityKindCardIdForOpenPredicateRulePublishesExplicitTargetScopeUncertaintyAll(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT applicability_kind, card_id
     FROM revision_legality_rule_applicability
     WHERE catalogue_revision_id = ? AND legality_rule_id = ?
     ORDER BY applicability_kind, card_id`);
}

export function readRevisionLegalityRuleApplicabilityApplicabilityKind(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT applicability_kind
     FROM revision_legality_rule_applicability
     WHERE catalogue_revision_id = ? AND legality_rule_id = ?`);
}
