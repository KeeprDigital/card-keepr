import type { SupportedGame } from "../shared/index";

export type ObservationCompleteness = {
  structurally_complete: boolean;
  required_surfaces_complete: boolean;
  partitions_complete: boolean;
  declared_record_count: number;
  parsed_record_count: number;
};

export type OfficialCardIdentity = { kind: "card_number"; value: string };
export type OfficialProductReference = { kind: "official_code" | "name"; value: string };
export type OfficialProduct = {
  code: string | null;
  title: string;
  distribution?: unknown;
};
export type OfficialRelease = {
  code: string | null;
  event_key: string;
  product_title?: string;
  // Publisher values remain evidence until reconciliation validates domain vocabulary.
  region: unknown;
  precision: unknown;
  date: unknown;
  status: unknown;
};
export type ProductReleaseCatalogue = {
  products: readonly {
    reference: OfficialProductReference;
    official_code: string | null;
    name: string;
    releases: readonly {
      event_key: unknown;
      region: unknown;
      date: { precision: unknown; value: unknown };
      status: unknown;
    }[];
  }[];
  distribution_contexts: readonly Record<string, unknown>[];
  relationships: readonly Record<string, unknown>[];
};

export type CatalogueObservation = {
  completeness: ObservationCompleteness;
  product_release_catalogue: ProductReleaseCatalogue;
  card?: {
    game: SupportedGame;
    official_identity: OfficialCardIdentity | { kind: "functional_designation"; value: "DON!!" };
    name: string;
    effective_rules_text: string | null;
    game_data: { profile: string; attributes: unknown };
  };
  printing?: {
    rarity: { raw: string | null; normalized: string | null };
    printed_rules_text: string | null;
    game_data: { profile: string; attributes: unknown };
  };
  identity_evidence?: Record<string, unknown>;
  appearance_evidence?: Record<string, unknown>;
  listing_identity_evidence?: { locator: string; canonical: string };
  memberships?: {
    products: readonly string[];
    distribution_contexts: readonly string[];
    source_buckets: readonly string[];
  };
  source_sidecar?: Record<string, unknown>;
};

export type OfficialErratumObservation = {
  kind: "official_erratum";
  game: SupportedGame;
  target:
    | { type: "card"; official_identity: OfficialCardIdentity }
    | { type: "printing"; official_identity: OfficialCardIdentity; locator: string };
  published_on: string;
  effective_from: string | null;
  observed_printed_rules_text: string;
  corrected_rules_text: string | null;
  official_wording: string;
  applies_to_parallel_printings: boolean;
  source: { fragment: string; display_name: string; image_url: string };
  completeness: ObservationCompleteness;
};

export type LegalityRulesObservation = {
  observation_type: "legality_rules";
  legality_rules: readonly Record<string, unknown>[];
  completeness: ObservationCompleteness;
  source_sidecar?: Record<string, unknown>;
};

export type SurfaceEvidenceObservation = {
  observation_type: "official_surface_evidence";
  source_lineage: string;
  surface: string;
  records: readonly {
    id: string;
    surface: string;
    method: "GET";
    url: string;
    headers: Record<string, string>;
    discovered_from?: Record<string, unknown>;
  }[];
  completeness: ObservationCompleteness;
  source_sidecar?: Record<string, unknown>;
};

// Existing wire shapes discriminate through kind, observation_type, or the
// product_release_catalogue field. No synthetic tag is added to retained output.
export type OfficialSourceObservation =
  | CatalogueObservation
  | OfficialErratumObservation
  | LegalityRulesObservation
  | SurfaceEvidenceObservation;

export type CardObservation = CatalogueObservation & {
  card: NonNullable<CatalogueObservation["card"]>;
  memberships: NonNullable<CatalogueObservation["memberships"]>;
};
