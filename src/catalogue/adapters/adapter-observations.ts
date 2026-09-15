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
  CatalogueObservation | OfficialErratumObservation | SurfaceEvidenceObservation | SourceAdmissionEvidenceObservation;

export type CardObservation = CatalogueObservation & {
  card: NonNullable<CatalogueObservation["card"]>;
  memberships: NonNullable<CatalogueObservation["memberships"]>;
};

/** Structurally valid source claims that cannot yet form a publishable Card. */
export type SourceAdmissionEvidenceObservation =
  | ScryfallSourceAdmissionEvidenceObservation
  | TcgdexSourceAdmissionEvidenceObservation
  | RiftboundDbSourceAdmissionEvidenceObservation;

export type ScryfallSourceAdmissionEvidenceObservation = {
  observation_type: "source_admission_evidence";
  game: "magic";
  source_lineage: "scryfall-magic-en";
  locator: string;
  declared_finishes: readonly string[];
  issues: readonly { code: "logical_parts_unresolved" | "category_unresolved"; source_paths: readonly string[] }[];
  appearance_evidence: {
    images: readonly { role: "front" | "back"; source_url: string; artwork_fingerprint: string }[];
  };
  source_sidecar: { source_record_json: string };
  completeness: ObservationCompleteness;
};

export type TcgdexSourceAdmissionEvidenceObservation = {
  observation_type: "source_admission_evidence";
  game: "pokemon";
  source_lineage: "tcgdex-pokemon-en";
  locator: string;
  source_membership: { set_id: string; local_id: string };
  target: { kind: "unresolved_record" };
  issues: readonly {
    code: "category_unresolved" | "card_identity_unresolved" | "printing_treatment_unresolved";
    source_paths: readonly string[];
  }[];
  appearance_evidence: {
    images: readonly {
      association: "source_record";
      role: "front" | "back";
      source_url: string;
      artwork_fingerprint: string;
      content_sha256?: string;
    }[];
  };
  source_sidecar: { source_record_json: string };
  completeness: ObservationCompleteness;
};

export type RiftboundDbSourceAdmissionEvidenceObservation = Omit<
  TcgdexSourceAdmissionEvidenceObservation,
  "game" | "source_lineage" | "issues"
> & {
  game: "riftbound";
  source_lineage: "riftbound-db-en";
  issues: readonly {
    code: "card_identity_unresolved" | "printing_treatment_unresolved" | "physical_issuance_unresolved";
    source_paths: readonly string[];
  }[];
};
