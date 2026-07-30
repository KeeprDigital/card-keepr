import type { FixtureCandidate } from "./fixture";
import { byteBoundedJsonArrays } from "./reconciliation-payload";
import { canonicalJson } from "./serialization";
import { legalityRuleCardIds } from "./legality-rule";

export function legalityPublicationStatements(
  database: D1Database,
  candidate: FixtureCandidate,
  revisionId: string,
): D1PreparedStatement[] {
  const rows = (candidate.legality_rules ?? []).map((rule) => ({
    id: rule.id,
    game: rule.game,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_from: rule.effective_from,
    effective_until: rule.effective_until,
    official_wording: rule.official_wording,
    effect_json: canonicalJson(rule.effect),
    card_ids_json: canonicalJson(legalityRuleCardIds(rule)),
    source_lineage: rule.source_lineage,
    source_snapshot_id: rule.source_snapshot_id,
    source_observation_set_id: rule.source_observation_set_id,
    source_observation_id: rule.source_observation_id,
    first_revision_id: rule.first_revision_id ?? revisionId,
    last_observed_revision_id:
      rule.last_observed_revision_id ?? revisionId,
    document_json: canonicalJson({
      ...rule,
      first_revision_id: rule.first_revision_id ?? revisionId,
      last_observed_revision_id:
        rule.last_observed_revision_id ?? revisionId,
    }),
  }));
  const chunks = byteBoundedJsonArrays(rows);
  return [
    ...chunks.map((chunk) =>
      database
        .prepare(
          `INSERT INTO legality_rules (
             id, supported_game, region, format, event_tier,
             effective_from, effective_until, official_wording,
             effect_json, card_ids_json, source_lineage,
             source_snapshot_id, source_observation_set_id,
             source_observation_id, first_revision_id,
             last_observed_revision_id
           )
           SELECT json_extract(value, '$.id'),
                  json_extract(value, '$.game'),
                  json_extract(value, '$.region'),
                  json_extract(value, '$.format'),
                  json_extract(value, '$.event_tier'),
                  json_extract(value, '$.effective_from'),
                  json_extract(value, '$.effective_until'),
                  json_extract(value, '$.official_wording'),
                  json_extract(value, '$.effect_json'),
                  json_extract(value, '$.card_ids_json'),
                  json_extract(value, '$.source_lineage'),
                  json_extract(value, '$.source_snapshot_id'),
                  json_extract(value, '$.source_observation_set_id'),
                  json_extract(value, '$.source_observation_id'),
                  json_extract(value, '$.first_revision_id'),
                  json_extract(value, '$.last_observed_revision_id')
           FROM json_each(?) WHERE true
           ON CONFLICT (id) DO UPDATE SET
             supported_game = excluded.supported_game,
             region = excluded.region,
             format = excluded.format,
             event_tier = excluded.event_tier,
             effective_from = excluded.effective_from,
             effective_until = excluded.effective_until,
             official_wording = excluded.official_wording,
             effect_json = excluded.effect_json,
             card_ids_json = excluded.card_ids_json,
             source_lineage = excluded.source_lineage,
             source_snapshot_id = excluded.source_snapshot_id,
             source_observation_set_id =
               excluded.source_observation_set_id,
             source_observation_id = excluded.source_observation_id,
             last_observed_revision_id =
               excluded.last_observed_revision_id`,
        )
        .bind(chunk),
    ),
    ...chunks.map((chunk) =>
      database
        .prepare(
          `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             card_ids_json, document_json
           )
           SELECT ?, json_extract(value, '$.id'),
                  json_extract(value, '$.game'),
                  json_extract(value, '$.region'),
                  json_extract(value, '$.format'),
                  json_extract(value, '$.event_tier'),
                  json_extract(value, '$.effective_from'),
                  json_extract(value, '$.effective_until'),
                  json_extract(value, '$.card_ids_json'),
                  json_extract(value, '$.document_json')
           FROM json_each(?)`,
        )
        .bind(revisionId, chunk),
    ),
  ];
}
