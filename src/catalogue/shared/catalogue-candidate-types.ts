// The pure shape of a Catalogue Candidate: the complete, immutable next
// version of Catalogue Data that one Ingestion Run's reconciliation puts
// forward. This module is a leaf: it declares types and constants only and
// imports nothing from the behaviour modules that reconcile, publish, or
// read these shapes, so every behaviour module can depend on it without
// forming an import cycle. The behaviour modules that historically owned
// these names (`catalogue-candidate`, `errata-rules-text`,
// `product-release-catalogue`) re-export them.
import type { CuratedProvenanceBearing } from "./curated-provenance";

export const catalogueCandidateContract = "card-keepr-catalogue-candidate@1" as const;

export type SupportedGame = "one-piece" | "fusion-world" | "digimon" | "gundam";

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
  source_checks?: readonly CatalogueSourceCheck[];
  errata?: readonly CatalogueErratum[];
  identity_corrections?: readonly {
    id: string;
    game: SupportedGame;
    entity_kind: "card" | "printing";
    action: "merge" | "split";
    replacement_ids: readonly string[];
  }[];
};

export type CatalogueSourceCheck = {
  game: SupportedGame;
  area: "cards-and-printings" | "products-and-releases" | "errata";
  checked_at: string;
};

export type CatalogueCard = CuratedProvenanceBearing & {
  id: string;
  game: SupportedGame;
  official_identity:
    | { kind: "unknown"; value: null }
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
    profile: "one-piece@1" | "fusion-world@1" | "digimon@1" | "gundam@1";
    attributes: Record<string, unknown>;
  };
};

export type CataloguePrinting = CuratedProvenanceBearing & {
  id: string;
  card_id: string;
  rarity: {
    normalized: string | null;
    raw: string | null;
  };
  printed_rules_text: string | null;
  game_data: {
    profile: "one-piece@1" | "fusion-world@1" | "digimon@1" | "gundam@1";
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

// Errata.

export type CatalogueErratum = Readonly<
  CuratedProvenanceBearing & {
    id: string;
    game: SupportedGame;
    target_type: "card" | "printing";
    target_id: string;
    effective_from: string | null;
    official_wording: string;
    corrected_value: string | null;
    provenance: readonly Readonly<{
      source_lineage: string;
      source_observation_id: string;
    }>[];
  }
>;

// Products, releases, distribution contexts, and product relationships.

export type EvidenceCategory = "explicit" | "derived" | "curated";
export type ReleaseStatus = "announced" | "released";
export type ReleasePrecision = "day" | "month" | "quarter" | "season" | "year" | "unknown";

export type ProductReference = {
  kind: "official_code" | "name";
  value: string;
};

export type ProductEvidenceResource = {
  type: "source_observation";
  id: string;
  captured_at: string;
  source: string;
  surface?: string;
  request_role?: "surface" | "listing" | "detail" | "product_detail" | "image";
  authority_class?: ProductAuthorityClass;
};

export type ProductAuthorityClass =
  | "product_detail"
  | "release_schedule"
  | "product_listing"
  | "card_detail"
  | "card_listing"
  | "policy"
  | "unknown";

export type ProductDisagreement = {
  path: string;
  status: "unresolved" | "resolved_by_authority";
  candidates: { value: unknown; observation_id: string }[];
};

export type ProductWithdrawal = {
  revision_id?: string;
  evidence: {
    assertion: "withdrawn";
    effective_at: string;
    evidence: string;
    source_lineage: string;
    source_snapshot_id: string;
    source_observation_set_id: string;
    source_observation_id: string;
  };
};

export type CatalogueProduct = CuratedProvenanceBearing & {
  reference: ProductReference;
  id: string;
  game: SupportedGame;
  official_code: string | null;
  name: string | null;
  releases: CatalogueRelease[];
  observed: boolean;
  withdrawal: ProductWithdrawal | null;
  included: ProductEvidenceResource[];
  provenance: Record<string, string[]>;
  disagreements: ProductDisagreement[];
  source_observations?: ProductSourceObservation[];
};

export type CatalogueRelease = CuratedProvenanceBearing & {
  id: string;
  event_key: string;
  product_id: string;
  region: "EN-OCEANIA" | "EN-ASIA" | "EN-US" | "unknown";
  date: {
    precision: ReleasePrecision | null;
    value: string | null;
  };
  status: ReleaseStatus | null;
};

export type CatalogueDistributionContext = CuratedProvenanceBearing & {
  id: string;
  game: SupportedGame;
  key: string;
  kind: "product" | "tournament_pack" | "winner_prize" | "promotion" | "other";
  label: string;
  product_id: string | null;
  evidence_category: EvidenceCategory;
  observed: boolean;
  source_lineages?: string[];
};

export type ProductEntityReference = {
  type: "printing" | "product" | "distribution_context" | "card";
  id: string;
};

export type ProductRelationship = CuratedProvenanceBearing & {
  id: string;
  game: SupportedGame;
  kind: "printing-product" | "printing-distribution-context" | "distribution-context-product" | "product-card";
  from: ProductEntityReference;
  to: ProductEntityReference;
  evidence_category: EvidenceCategory;
  resolution: "canonical";
  source_lineage?: string;
  source_observation_ids: string[];
  relationship_value: string;
  observed: boolean;
};

export type ProductSourceObservation = {
  reference: ProductReference;
  id: string;
  officialCode: string | null;
  name: string;
  releases: {
    eventKey: string;
    region: CatalogueRelease["region"];
    precision: ReleasePrecision;
    value: string | null;
    status: ReleaseStatus | null;
  }[];
  withdrawal: ProductWithdrawal | null;
  evidence: ProductEvidenceResource;
  carriedOfficialCode?: {
    value: string;
    evidence: ProductEvidenceResource[];
  };
};
