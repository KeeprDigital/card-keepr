import {
  type CatalogueCandidate,
  canonicalJson,
  sha256Text,
  utf8,
  CatalogueExportLimitError,
  maximumExportComponentBytes,
  maximumLegalityRuleRelationships,
  maximumLegalityStatusRules,
} from "../shared";
import { legalityExportKind, legalityRuleCardIds, normalizedLegalityRuleLifecycle } from "./legality-rule";
import { canonicalLegalityRuleEffect } from "./legality-effect-policy";

export function legalityRuleExportRecords(candidate: CatalogueCandidate, revisionId: string) {
  return (candidate.legality_rules ?? []).map((rule) => ({
    type: "legality_rule",
    id: rule.id,
    official_id: rule.official_id,
    game: rule.game,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_from: rule.effective_from,
    effective_until: rule.effective_until,
    unresolved_scope: rule.unresolved_scope,
    kind: legalityExportKind(rule.effect),
    effect: canonicalLegalityRuleEffect(rule.effect),
    card_ids: legalityRuleCardIds(rule),
    official_wording: rule.official_wording,
    source_lineage: rule.source_lineage,
    source_observation_ids: [rule.source_observation_id],
    source_observation_pointer: rule.source_observation_pointer,
    source_field_pointers: rule.source_field_pointers,
    ...("curated_provenance" in rule && Array.isArray(rule.curated_provenance)
      ? { curated_provenance: rule.curated_provenance }
      : {}),
    lifecycle: normalizedLegalityRuleLifecycle(rule, revisionId),
  }));
}

export async function legalityRuleRelationshipRecords(candidate: CatalogueCandidate, revisionId: string) {
  const relationships = (candidate.legality_rules ?? []).map((rule) => ({
    rule,
    cardIds: legalityRuleCardIds(rule),
  }));
  let count = 0;
  let estimatedBytes = 0;
  for (const { rule, cardIds } of relationships) {
    count += Math.max(1, cardIds.length);
    if (count > maximumLegalityRuleRelationships || count > maximumLegalityStatusRules) {
      throw new CatalogueExportLimitError("Legality Rule applicability exceeds the 16,384-record publication budget.");
    }
    for (const cardId of cardIds) {
      estimatedBytes += utf8(
        `${canonicalJson(
          legalityRuleRelationshipRecord(rule, cardId, revisionId, `relationship_${"0".repeat(64)}`),
        )}\n`,
      ).byteLength;
      if (estimatedBytes > maximumExportComponentBytes) {
        throw new CatalogueExportLimitError("Legality Rule relationships exceed the 12 MiB component byte budget.");
      }
    }
  }

  const records = [];
  for (const { rule, cardIds } of relationships) {
    for (const cardId of cardIds) {
      const id = `relationship_${await sha256Text(
        canonicalJson({
          kind: "legality-rule-card",
          legality_rule_id: rule.id,
          card_id: cardId,
        }),
      )}`;
      records.push(legalityRuleRelationshipRecord(rule, cardId, revisionId, id));
    }
  }
  return records;
}

function legalityRuleRelationshipRecord(
  rule: NonNullable<CatalogueCandidate["legality_rules"]>[number],
  cardId: string,
  revisionId: string,
  id: string,
) {
  return {
    type: "relationship" as const,
    id,
    kind: "legality-rule-card" as const,
    from: { type: "legality_rule", id: rule.id },
    to: { type: "card", id: cardId },
    evidence_category: "explicit" as const,
    source_lineage: rule.source_lineage,
    source_observation_ids: [rule.source_observation_id],
    relationship_value: rule.id,
    lifecycle: normalizedLegalityRuleLifecycle(rule, revisionId),
  };
}
