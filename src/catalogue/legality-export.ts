import type { CatalogueCandidate } from "./catalogue-candidate";
import {
  legalityExportKind,
  legalityRuleCardIds,
  type LegalityRuleEffect,
} from "./legality-rule";
import {
  canonicalJson,
  compareUtf8,
  sha256Text,
} from "./serialization";

export function legalityRuleExportRecords(
  candidate: CatalogueCandidate,
  revisionId: string,
) {
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
    kind: legalityExportKind(rule.effect),
    effect: exportEffect(rule.effect),
    card_ids: legalityRuleCardIds(rule),
    official_wording: rule.official_wording,
    source_lineage: rule.source_lineage,
    source_observation_ids: [rule.source_observation_id],
    lifecycle: {
      first_revision_id: rule.first_revision_id ?? revisionId,
      last_observed_revision_id:
        rule.last_observed_revision_id ?? revisionId,
      current: rule.current ?? true,
      last_missing_revision_id:
        rule.current === false
          ? rule.last_missing_revision_id ?? revisionId
          : rule.last_missing_revision_id ?? null,
    },
  }));
}

function exportEffect(effect: LegalityRuleEffect): LegalityRuleEffect {
  if (effect.type !== "prohibited_combination") return effect;
  return {
    ...effect,
    with_card_ids: [...new Set(effect.with_card_ids)].sort(compareUtf8),
  };
}

export async function legalityRuleRelationshipRecords(
  candidate: CatalogueCandidate,
  revisionId: string,
) {
  return Promise.all(
    (candidate.legality_rules ?? []).flatMap((rule) =>
      legalityRuleCardIds(rule).map(async (cardId) => ({
        type: "relationship" as const,
        id: `relationship_${await sha256Text(
          canonicalJson({
            kind: "legality-rule-card",
            legality_rule_id: rule.id,
            card_id: cardId,
          }),
        )}`,
        kind: "legality-rule-card" as const,
        from: { type: "legality_rule", id: rule.id },
        to: { type: "card", id: cardId },
        evidence_category: "explicit" as const,
        source_lineage: rule.source_lineage,
        source_observation_ids: [rule.source_observation_id],
        relationship_value: rule.id,
        lifecycle: {
          first_revision_id: rule.first_revision_id ?? revisionId,
          last_observed_revision_id:
            rule.last_observed_revision_id ?? revisionId,
          current: rule.current ?? true,
          last_missing_revision_id:
            rule.current === false
              ? rule.last_missing_revision_id ?? revisionId
              : rule.last_missing_revision_id ?? null,
        },
      })),
    ),
  );
}
