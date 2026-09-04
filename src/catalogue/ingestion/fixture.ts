import { canonicalJson, sha256Text, catalogueCandidateContract, type CatalogueCandidate } from "../shared";

export const firstCatalogueFixture = "first-catalogue";
export const firstFixtureCardId = "card_01k_first_catalogue_0001";
export const firstFixturePrintingId = "printing_01k_first_catalogue_0001";

export async function fixtureCandidate(
  fixture: string,
  selectedGames: readonly string[],
): Promise<{ candidate: CatalogueCandidate; digest: string }> {
  if (fixture !== firstCatalogueFixture) {
    throw new FixtureInputError("fixture_not_found", "The requested controlled ingestion fixture does not exist.");
  }
  if (selectedGames.length !== 1 || selectedGames[0] !== "one-piece") {
    throw new FixtureInputError("fixture_game_mismatch", "The first-catalogue fixture must select exactly one-piece.");
  }

  const candidate: CatalogueCandidate = {
    contract: catalogueCandidateContract,
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
        effective_rules_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
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
            effect_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
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
        printed_rules_text: "[DON!! x1] This Leader gains +1000 power during your turn.",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            illustration_types: [],
          },
        },
      },
    ],
    errata: [],
    legality_rules: [],
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
