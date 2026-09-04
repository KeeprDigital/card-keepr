import { describe, expect, test } from "vitest";
import type { CatalogueCard } from "../../src/catalogue/shared";
import { reconcileDigimonCardAuthority } from "../../src/catalogue/reconciliation";

type CardFacts = Omit<CatalogueCard, "id">;

describe("Digimon Card authority", () => {
  test("an explicit official Erratum resolves only typed-text disagreement", () => {
    const base = digimonCard("Printed effect before correction.");
    const correctedPrinting = digimonCard("Corrected official effect.");

    expect(
      reconcileDigimonCardAuthority({ card: base, hasBaseRecord: true }, correctedPrinting, false, {
        effectiveRulesText: "official_errata",
      }),
    ).toEqual({
      kind: "accepted",
      authority: { card: base, hasBaseRecord: true },
    });
  });

  test("typed-text disagreement still blocks without Erratum authority", () => {
    const result = reconcileDigimonCardAuthority(
      { card: digimonCard("First effect."), hasBaseRecord: true },
      digimonCard("Second effect."),
      false,
      { effectiveRulesText: "source_consensus" },
    );

    expect(result.kind).toBe("conflict");
  });

  test("Erratum authority does not excuse unrelated rules-fact disagreement", () => {
    const proposed = digimonCard("Corrected official effect.");
    proposed.game_data.attributes.dp = 11_000;
    const result = reconcileDigimonCardAuthority(
      { card: digimonCard("Printed effect before correction."), hasBaseRecord: true },
      proposed,
      false,
      { effectiveRulesText: "official_errata" },
    );

    expect(result.kind).toBe("conflict");
  });
});

function digimonCard(effect: string): CardFacts {
  return {
    game: "digimon",
    official_identity: { kind: "card_number", value: "BT99-001" },
    name: "Synthetic Base Digimon",
    effective_rules_text: "Corrected official effect.",
    game_data: {
      profile: "digimon@1",
      attributes: {
        card_type: "digimon",
        colours: ["blue"],
        level: 6,
        play_cost: 11,
        use_cost: null,
        dp: 12_000,
        form: "Mega",
        attribute: "Vaccine",
        traits: ["Synthetic Dragon"],
        digivolution_requirements: [],
        text_sections: [{ kind: "effect", text: effect }],
      },
    },
  };
}
