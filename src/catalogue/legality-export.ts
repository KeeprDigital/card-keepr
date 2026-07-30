import type { FixtureCandidate } from "./fixture";
import {
  legalityExportKind,
  legalityRuleCardIds,
} from "./legality-rule";
import { canonicalJson, sha256Text } from "./serialization";

export function legalityRuleExportRecords(candidate: FixtureCandidate) {
  return (candidate.legality_rules ?? []).map((rule) => ({
    type: "legality_rule",
    id: rule.id,
    game: rule.game,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_from: rule.effective_from,
    effective_until: rule.effective_until,
    kind: legalityExportKind(rule.effect),
    card_ids: legalityRuleCardIds(rule),
    official_wording: rule.official_wording,
  }));
}

export async function legalityRuleRelationshipRecords(
  candidate: FixtureCandidate,
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
          current: true,
          last_missing_revision_id: null,
        },
      })),
    ),
  );
}
