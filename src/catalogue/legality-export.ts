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
  utf8,
} from "./serialization";
import {
  CatalogueExportLimitError,
  maximumExportComponentBytes,
  maximumLegalityRuleRelationships,
} from "./export-limits";

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
    source_observation_pointer: rule.source_observation_pointer,
    source_field_pointers: rule.source_field_pointers,
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
  const relationships = (candidate.legality_rules ?? []).map((rule) => ({
    rule,
    cardIds: legalityRuleCardIds(rule),
  }));
  let count = 0;
  let estimatedBytes = 0;
  for (const { rule, cardIds } of relationships) {
    count += cardIds.length;
    if (count > maximumLegalityRuleRelationships) {
      throw new CatalogueExportLimitError(
        "Legality Rule relationships exceed the 16,384-record export budget.",
      );
    }
    for (const cardId of cardIds) {
      estimatedBytes += utf8(`${canonicalJson(
        legalityRuleRelationshipRecord(
          rule,
          cardId,
          revisionId,
          `relationship_${"0".repeat(64)}`,
        ),
      )}\n`).byteLength;
      if (estimatedBytes > maximumExportComponentBytes) {
        throw new CatalogueExportLimitError(
          "Legality Rule relationships exceed the 12 MiB component byte budget.",
        );
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
      records.push(
        legalityRuleRelationshipRecord(rule, cardId, revisionId, id),
      );
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
  };
}
