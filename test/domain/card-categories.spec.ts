import { expect, test } from "vitest";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { capacityPageDocument, syntheticCapacityTier } from "../support/fake-publisher/capacity-workloads";
import { derivedCardModel, gameProfileCardClassification } from "../../src/catalogue/shared";

test("art Card evidence is representable without invented gameplay properties", () => {
  const observation = parseReconciliationObservation("observed-art", {
    memberships: { products: [], distribution_contexts: [], source_buckets: [] },
    card: {
      game: "one-piece",
      category: "art",
      gameplay_applicability: "inapplicable",
      official_identity: { kind: "card_number", value: "ART-001" },
      name: "Illustration study",
      effective_rules_text: null,
      game_data: { profile: "one-piece@1", attributes: {} },
    },
  });
  expect(observation.kind).toBe("card_printing");
  if (observation.kind !== "card_printing") throw new Error("Expected Card evidence");
  expect(observation.observedCardAndPrinting.card).toMatchObject({
    category: "art",
    gameplay_applicability: "inapplicable",
    effective_rules_text: null,
    game_data: { profile: "one-piece@1", attributes: {} },
  });
  expect(observation.sourceWarnings).toEqual([]);
});

test("fresh preparation derives existing profile token meanings without changing retained facts", () => {
  for (const [profile, attributes] of [
    ["gundam@1", { card_type: "unit_token" }],
    ["riftbound@1", { supertypes: ["token"] }],
  ] as const) {
    const retained = { id: "retained-card", game_data: { profile, attributes } };
    const before = structuredClone(retained);
    expect(derivedCardModel(retained)).toEqual({
      category: "token",
      gameplay_applicability: "applicable",
      related_cards: [],
    });
    expect(retained).toEqual(before);
    expect(() => derivedCardModel({ ...retained, category: "gameplay" })).toThrow();
    expect(() => gameProfileCardClassification(profile, attributes, null)).toThrow();
  }
});

test("art Printings reject gameplay text and distinguish inapplicability from unknown text", () => {
  const original = capacityPageDocument(syntheticCapacityTier("2-images"), 0).cards[0]!;
  const source = {
    ...original,
    card: {
      ...original.card,
      category: "art",
      gameplay_applicability: "inapplicable",
      effective_rules_text: null,
      game_data: { ...original.card.game_data, attributes: {} },
    },
    printing: { ...original.printing, printed_rules_text: null as string | null },
  };
  const parsed = parseReconciliationObservation("observed-art-printing", source);
  if (parsed.kind !== "card_printing") throw new Error("Expected Card and Printing evidence");
  expect(parsed.observedCardAndPrinting.printing).toMatchObject({
    gameplay_applicability: "inapplicable",
    printed_rules_text: null,
  });
  source.printing.printed_rules_text = "Invented rules";
  expect(() => parseReconciliationObservation("contradictory-art", source)).toThrow(/inapplicable/);
});
