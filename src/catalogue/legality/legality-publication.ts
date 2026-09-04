import {
  publishLegalityRuleFactsStatement,
  publishRevisionLegalityRulesStatement,
} from "./../legality/legality-publication-repository";
import { byteBoundedJsonArrays, type CatalogueCandidate, canonicalJson } from "../shared";
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
    ...chunks.map((chunk) => publishLegalityRuleFactsStatement(database, chunk)),
    ...chunks.map((chunk) =>
      publishRevisionLegalityRulesStatement(database, { revisionId: revisionId, payload: chunk }),
    ),
  ];
}
