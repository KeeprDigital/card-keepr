import { type CatalogueCandidate, byteBoundedJsonArrays, canonicalJson } from "../shared";
import { legalityRuleCardIds } from "./legality-rule";
import { normalizedLegalityRuleLifecycle } from "./legality-rule-lifecycle";

export function legalityPublicationStatements(
  database: D1Database,
  candidate: CatalogueCandidate,
  revisionId: string,
): D1PreparedStatement[] {
  const rows = (candidate.legality_rules ?? []).map((rule) => {
    const lifecycle = normalizedLegalityRuleLifecycle(rule, revisionId);
    return {
      id: rule.id,
      official_id: rule.official_id,
      game: rule.game,
      region: rule.region,
      format: rule.format,
      event_tier: rule.event_tier,
      effective_from: rule.effective_from,
      effective_until: rule.effective_until,
      unresolved_scope_json: canonicalJson(rule.unresolved_scope),
      official_wording: rule.official_wording,
      effect_json: canonicalJson(rule.effect),
      card_ids_json: canonicalJson(legalityRuleCardIds(rule)),
      direct_card_ids_json: canonicalJson(rule.card_ids),
      source_lineage: rule.source_lineage,
      source_snapshot_id: rule.source_snapshot_id,
      source_observation_set_id: rule.source_observation_set_id,
      source_observation_id: rule.source_observation_id,
      source_observation_pointer: rule.source_observation_pointer,
      source_field_pointers_json: canonicalJson(rule.source_field_pointers),
      first_revision_id: lifecycle.first_revision_id,
      last_observed_revision_id: lifecycle.last_observed_revision_id,
      current: lifecycle.current ? 1 : 0,
      last_missing_revision_id: lifecycle.last_missing_revision_id,
      document_json: canonicalJson({
        ...rule,
        ...lifecycle,
      }),
    };
  });
  const chunks = byteBoundedJsonArrays(rows);
  return [
    ...chunks.map((chunk) =>
      database
        .prepare(
          `INSERT INTO legality_rules (
             id, official_id, supported_game, region, format, event_tier,
             effective_from, effective_until, official_wording,
             unresolved_scope_json, effect_json, card_ids_json,
             direct_card_ids_json, source_lineage,
             source_snapshot_id, source_observation_set_id,
             source_observation_id, source_observation_pointer,
             source_field_pointers_json, first_revision_id,
             last_observed_revision_id, current,
             last_missing_revision_id
           )
           SELECT json_extract(value, '$.id'),
                  json_extract(value, '$.official_id'),
                  json_extract(value, '$.game'),
                  json_extract(value, '$.region'),
                  json_extract(value, '$.format'),
                  json_extract(value, '$.event_tier'),
                  json_extract(value, '$.effective_from'),
                  json_extract(value, '$.effective_until'),
                  json_extract(value, '$.official_wording'),
                  json_extract(value, '$.unresolved_scope_json'),
                  json_extract(value, '$.effect_json'),
                  json_extract(value, '$.card_ids_json'),
                  json_extract(value, '$.direct_card_ids_json'),
                  json_extract(value, '$.source_lineage'),
                  json_extract(value, '$.source_snapshot_id'),
                  json_extract(value, '$.source_observation_set_id'),
                  json_extract(value, '$.source_observation_id'),
                  json_extract(value, '$.source_observation_pointer'),
                  json_extract(value, '$.source_field_pointers_json'),
                  json_extract(value, '$.first_revision_id'),
                  json_extract(value, '$.last_observed_revision_id'),
                  json_extract(value, '$.current'),
                  json_extract(value, '$.last_missing_revision_id')
           FROM json_each(?) WHERE true
           ON CONFLICT (id) DO UPDATE SET
             last_observed_revision_id =
               excluded.last_observed_revision_id,
             current = excluded.current,
             last_missing_revision_id =
               excluded.last_missing_revision_id`,
        )
        .bind(chunk),
    ),
    ...chunks.map((chunk) =>
      database
        .prepare(
          `INSERT INTO revision_legality_rules (
             catalogue_revision_id, legality_rule_id, supported_game,
             region, format, event_tier, effective_from, effective_until,
             unresolved_scope_json, card_ids_json, source_retrieved_at,
             document_json
           )
           SELECT ?, canonical.id, canonical.supported_game,
                  canonical.region, canonical.format,
                  canonical.event_tier, canonical.effective_from,
                  canonical.effective_until, canonical.unresolved_scope_json,
                  canonical.card_ids_json,
                  -- The Legality Status evidence sidecar reports the Source
                  -- Snapshot's retrieval instant as captured_at; projecting it
                  -- here keeps the api worker on published projections
                  -- (issue #98). A rule whose snapshot is absent leaves it
                  -- NULL and the projection guard rejects the publication.
                  (SELECT snapshot.retrieved_at FROM source_snapshots AS snapshot
                   WHERE snapshot.id = canonical.source_snapshot_id),
                  json_set(
                    json_extract(value, '$.document_json'),
                    '$.source_snapshot_id',
                    canonical.source_snapshot_id,
                    '$.source_observation_set_id',
                    canonical.source_observation_set_id,
                    '$.source_observation_id',
                    canonical.source_observation_id,
                    '$.source_observation_pointer',
                    canonical.source_observation_pointer,
                    '$.source_field_pointers',
                    json(canonical.source_field_pointers_json),
                    '$.first_revision_id',
                    canonical.first_revision_id,
                    '$.last_observed_revision_id',
                    canonical.last_observed_revision_id,
                    '$.current',
                    json(CASE canonical.current
                      WHEN 1 THEN 'true' ELSE 'false' END),
                    '$.last_missing_revision_id',
                    canonical.last_missing_revision_id
                  )
           FROM json_each(?) AS incoming
           JOIN legality_rules AS canonical
             ON canonical.id = json_extract(value, '$.id')`,
        )
        .bind(revisionId, chunk),
    ),
  ];
}
