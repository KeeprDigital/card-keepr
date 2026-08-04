import { expect, test } from "vitest";
import type { CatalogueCandidate } from "../../../src/catalogue/catalogue-candidate";
import { legalityRuleExportRecords } from "../../../src/catalogue/legality-export";
import type { LegalityRuleEffect } from "../../../src/catalogue/legality-rule";
import { canonicalNdjson } from "../../../src/catalogue/serialization";

test("v3 Legality Rule export canonicalizes every set-valued effect operand", () => {
  const rule = {
    id: "rule_deterministic_effect",
    official_id: "RULE-DETERMINISTIC-EFFECT",
    game: "fusion-world" as const,
    region: "EN-OCEANIA" as const,
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    unresolved_scope: null,
    card_ids: ["card_primary"],
    official_wording: "Publisher wording retained verbatim.",
    source_lineage: "fusion-world-en",
    source_snapshot_id: "snapshot_deterministic_effect",
    source_observation_set_id: "observation_set_deterministic_effect",
    source_observation_id: "observation_deterministic_effect",
    source_observation_pointer: "/observations/0/value/legality_rules/0",
    source_field_pointers: {
      official_wording: "/observations/0/value/legality_rules/0/official_wording",
      effective_from: "/observations/0/value/legality_rules/0/effective_from",
      effective_until: "/observations/0/value/legality_rules/0/effective_until",
      unresolved_scope: "/observations/0/value/legality_rules/0/unresolved_scope",
      region: "/observations/0/value/legality_rules/0/region",
      format: "/observations/0/value/legality_rules/0/format",
      event_tier: "/observations/0/value/legality_rules/0/event_tier",
      card_numbers: "/observations/0/value/legality_rules/0/card_numbers",
      effect: "/observations/0/value/legality_rules/0/effect",
    },
  };
  const cases: Array<{
    left: LegalityRuleEffect;
    right: LegalityRuleEffect;
    field: "includes_any" | "eligible_blocks";
    expected: string[];
  }> = [
    {
      left: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Saiyan", "Earthling", "Saiyan"],
      },
      right: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Earthling", "Saiyan"],
      },
      field: "includes_any",
      expected: ["Earthling", "Saiyan"],
    },
    {
      left: { type: "rotation", eligible_blocks: ["02", "01", "02"] },
      right: { type: "rotation", eligible_blocks: ["01", "02"] },
      field: "eligible_blocks",
      expected: ["01", "02"],
    },
    {
      left: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Cafe\u0301", "Café"],
      },
      right: {
        type: "membership",
        attribute: "traits",
        includes_any: ["Café"],
      },
      field: "includes_any",
      expected: ["Café"],
    },
  ];

  for (const { left, right, field, expected } of cases) {
    const bytes = (effect: LegalityRuleEffect) =>
      canonicalNdjson(legalityRuleExportRecords({
        contract: "card-keepr-catalogue-candidate@1",
        selected_games: ["fusion-world"],
        cards: [],
        printings: [],
        legality_rules: [{ ...rule, effect }],
      } satisfies CatalogueCandidate, "revision_deterministic_effect"));
    const leftBytes = bytes(left);
    const rightBytes = bytes(right);
    expect(leftBytes, left.type).toEqual(rightBytes);
    const record = JSON.parse(new TextDecoder().decode(leftBytes)) as {
      effect: Record<string, unknown>;
    };
    expect(record.effect[field], left.type).toEqual(expected);
  }
});
