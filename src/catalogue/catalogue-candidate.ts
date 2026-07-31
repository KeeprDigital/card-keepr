import type {
  CatalogueDistributionContext,
  CatalogueProduct,
  ProductRelationship,
} from "./product-release-catalogue";
import type { CatalogueErratum } from "./errata-rules-text";

export const catalogueCandidateContract =
  "card-keepr-catalogue-candidate@1" as const;

export type SupportedGame =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

export type CatalogueCandidate = {
  contract: typeof catalogueCandidateContract;
  selected_games: readonly SupportedGame[];
  cards: readonly CatalogueCard[];
  printings: readonly CataloguePrinting[];
  printing_images?: readonly CataloguePrintingImage[];
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

export type CatalogueCard = {
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

export type CataloguePrinting = {
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

export type CataloguePrintingImage = {
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
