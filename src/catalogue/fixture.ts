import { canonicalJson, sha256Text } from "./serialization";

export const firstCatalogueFixture = "first-catalogue";
export const firstFixtureCardId = "card_01k_first_catalogue_0001";
export const firstFixturePrintingId = "printing_01k_first_catalogue_0001";

export type SupportedGame =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

export type FixtureCandidate = {
  fixture: typeof firstCatalogueFixture;
  selected_games: readonly ["one-piece"];
  cards: readonly [FixtureCard];
  printings: readonly [FixturePrinting];
};

export type FixtureCard = {
  id: string;
  game: "one-piece";
  official_identity: {
    kind: "card_number";
    value: string;
  };
  name: string;
  effective_rules_text: string;
  game_data: {
    profile: "one-piece@1";
    attributes: {
      card_type: "leader";
      colours: readonly ["red"];
      cost: null;
      life: number;
      battle_attributes: readonly ["strike"];
      power: number;
      counter: null;
      traits: readonly ["Straw Hat Crew"];
      block_icons: readonly ["1"];
      effect_text: string;
      trigger_text: null;
    };
  };
};

export type FixturePrinting = {
  id: string;
  card_id: string;
  rarity: {
    normalized: string;
    raw: string;
  };
  printed_rules_text: string;
  game_data: {
    profile: "one-piece@1";
    attributes: {
      illustration_types: readonly [];
    };
  };
};

export async function fixtureCandidate(
  fixture: string,
  selectedGames: readonly string[],
): Promise<{ candidate: FixtureCandidate; digest: string }> {
  if (fixture !== firstCatalogueFixture) {
    throw new FixtureInputError(
      "fixture_not_found",
      "The requested controlled ingestion fixture does not exist.",
    );
  }
  if (
    selectedGames.length !== 1 ||
    selectedGames[0] !== "one-piece"
  ) {
    throw new FixtureInputError(
      "fixture_game_mismatch",
      "The first-catalogue fixture must select exactly one-piece.",
    );
  }

  const candidate: FixtureCandidate = {
    fixture: firstCatalogueFixture,
    selected_games: ["one-piece"],
    cards: [
      {
        id: firstFixtureCardId,
        game: "one-piece",
        official_identity: {
          kind: "card_number",
          value: "OP01-001",
        },
        name: "Monkey.D.Luffy",
        effective_rules_text:
          "[DON!! x1] This Leader gains +1000 power during your turn.",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            card_type: "leader",
            colours: ["red"],
            cost: null,
            life: 5,
            battle_attributes: ["strike"],
            power: 5000,
            counter: null,
            traits: ["Straw Hat Crew"],
            block_icons: ["1"],
            effect_text:
              "[DON!! x1] This Leader gains +1000 power during your turn.",
            trigger_text: null,
          },
        },
      },
    ],
    printings: [
      {
        id: firstFixturePrintingId,
        card_id: firstFixtureCardId,
        rarity: {
          normalized: "leader",
          raw: "L",
        },
        printed_rules_text:
          "[DON!! x1] This Leader gains +1000 power during your turn.",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            illustration_types: [],
          },
        },
      },
    ],
  };

  return {
    candidate,
    digest: await sha256Text(canonicalJson(candidate)),
  };
}

export class FixtureInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
