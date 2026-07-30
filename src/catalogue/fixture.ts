import { canonicalJson, sha256Text } from "./serialization";
import type {
  CatalogueDistributionContext,
  CatalogueProduct,
  ProductRelationship,
} from "./product-release-catalogue";
import type { CatalogueErratum } from "./errata-rules-text";

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
  selected_games: readonly SupportedGame[];
  cards: readonly FixtureCard[];
  printings: readonly FixturePrinting[];
  printing_images?: readonly FixturePrintingImage[];
  products?: readonly CatalogueProduct[];
  distribution_contexts?: readonly CatalogueDistributionContext[];
  product_relationships?: readonly ProductRelationship[];
  card_observed_games?: readonly SupportedGame[];
  product_observed_games?: readonly SupportedGame[];
  product_observed_lineages?: readonly string[];
  source_checks?: readonly {
    game: SupportedGame;
    area: "cards-and-printings" | "products-and-releases";
    checked_at: string;
  }[];
  errata?: readonly CatalogueErratum[];
};

export type FixtureCard = {
  id: string;
  game: SupportedGame;
  official_identity:
    | {
        kind: "card_number";
        value: string;
      }
    | {
        kind: "functional_designation";
        value: "DON!!";
      };
  name: string;
  effective_rules_text: string | null;
  game_data: {
    profile:
      | "one-piece@1"
      | "fusion-world@1"
      | "digimon@1"
      | "gundam@1";
    attributes: Record<string, unknown>;
  };
};

export type FixturePrinting = {
  id: string;
  card_id: string;
  rarity: {
    normalized: string | null;
    raw: string | null;
  };
  printed_rules_text: string | null;
  game_data: {
    profile:
      | "one-piece@1"
      | "fusion-world@1"
      | "digimon@1"
      | "gundam@1";
    attributes: Record<string, unknown>;
  } | null;
};

export type FixturePrintingImage = {
  id: string;
  printing_id: string;
  role: "front" | "back" | "other";
  media_type: `image/${string}`;
  width: number;
  height: number;
  content_sha256: string;
  content_byte_length: number;
  object_key: string;
  source_url: string;
  content_base64: string;
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
    errata: [],
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
