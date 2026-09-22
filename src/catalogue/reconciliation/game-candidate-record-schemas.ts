import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";
import { requiredProfileContract } from "../shared";

const count = z.number().int().nonnegative();
const text = z.string().nullable(); // Long strings are replaced by null and described by text_parts.
const game = z.enum(gameProfileRegistrations().map(({ game }) => game));
export { sourceValue, retainedSourceObject } from "../shared";
import { sourceValue } from "../shared";
export const textPart = z.strictObject({
  path: z.array(z.union([z.string(), count])),
  sha256: digest,
  chunks: count,
  byte_length: count,
});
export const textParts = z.array(z.array(textPart));
const entityReference = z.strictObject({
  type: z.enum(["card", "printing", "product", "distribution_context"]),
  id: identifier,
});
const relationshipKind = z.enum([
  "printing-product",
  "printing-distribution-context",
  "distribution-context-product",
  "product-card",
]);
export const curatedTarget = z.union([
  z.strictObject({
    kind: z.literal("field"),
    entity_type: z.enum(["card", "printing", "product", "release", "distribution_context", "erratum"]),
    entity_id: identifier,
    path: text,
  }),
  z.strictObject({
    kind: z.literal("relationship"),
    relationship_kind: relationshipKind,
    from: entityReference,
    to: entityReference,
  }),
]);
export const curatedEvidence = z.array(
  z.union([
    z.strictObject({ kind: z.literal("source_observation"), id: identifier }),
    z.strictObject({ kind: z.literal("owner_reference"), uri: text, content_digest: digest }),
  ]),
);
const curated = {
  curated_provenance: z
    .array(
      z.strictObject({
        curated_revision_id: identifier,
        content_digest: digest,
        target: curatedTarget,
        rationale: text,
        evidence: curatedEvidence,
        author: text,
        reviewed_source_value: sourceValue,
      }),
    )
    .optional(),
};
export const officialIdentity = z.union([
  z.strictObject({ kind: z.enum(["card_number", "publisher_name"]), value: text }),
  z.strictObject({ kind: z.literal("functional_designation"), value: z.literal("DON!!") }),
  z.strictObject({ kind: z.literal("unknown"), value: z.null() }),
]);
type ProfileSchema = ReturnType<typeof requiredProfileContract>["card"]["properties"][string];
function profileWire(schema: ProfileSchema): z.ZodType {
  switch (schema.kind) {
    case "string":
      return text;
    case "integer":
      return schema.nullable ? z.number().int().nullable() : z.number().int();
    case "boolean":
      return z.boolean();
    case "enum":
      return z.enum(schema.values);
    case "array": {
      const value = z.array(profileWire(schema.items));
      return schema.nullable ? value.nullable() : value;
    }
    case "object":
      return z.strictObject(
        Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => [
            key,
            schema.required.includes(key) ? profileWire(value) : profileWire(value).optional(),
          ]),
        ),
      );
  }
}
const profileData = (kind: "card" | "printing") =>
  z.union(
    gameProfileRegistrations().map(({ id }) =>
      z.strictObject({ profile: z.literal(id), attributes: profileWire(requiredProfileContract(id)[kind]) }),
    ),
  );
const artData = z.union(
  gameProfileRegistrations().map(({ id }) =>
    z.strictObject({ profile: z.literal(id), attributes: z.strictObject({}) }),
  ),
);
const cardFields = {
  ...curated,
  id: identifier,
  game,
  official_identity: officialIdentity,
  name: text,
  effective_rules_text: text,
  related_cards: z
    .array(
      z.strictObject({
        kind: z.literal("shared_artwork"),
        card_id: identifier,
        evidence: z.array(
          z.strictObject({
            source_observation_id: identifier,
            printing_id: identifier,
            related_printing_id: identifier,
            related_source_observation_id: identifier,
            artwork_fingerprint: text,
          }),
        ),
      }),
    )
    .max(8),
};
const gameplayCard = z.strictObject({
  ...cardFields,
  category: z.enum(["gameplay", "token"]),
  gameplay_applicability: z.literal("applicable"),
  game_data: profileData("card"),
});
const artCard = z.strictObject({
  ...cardFields,
  category: z.literal("art"),
  gameplay_applicability: z.literal("inapplicable"),
  game_data: artData,
});
export const cardRecord = z
  .union([gameplayCard.openapi("CandidateGameplayCard"), artCard.openapi("CandidateArtCard")])
  .openapi("CandidateCard");
export const observedCard = z
  .union([gameplayCard.omit({ id: true }), artCard.omit({ id: true })])
  .openapi("CandidateObservedCard");
export const historicalCard = gameplayCard
  .omit({ category: true, gameplay_applicability: true, related_cards: true })
  .openapi("RetainedPreCategoryCard");
export const historicalObservedCard = historicalCard.omit({ id: true }).openapi("RetainedPreCategoryObservedCard");
const printingFields = {
  ...curated,
  id: identifier,
  card_id: identifier,
  gameplay_applicability: z.enum(["applicable", "inapplicable"]),
  rarity: z.strictObject({ normalized: text, raw: text }),
  printed_rules_text: text,
  game_data: z.union([profileData("printing"), artData]).nullable(),
  locator_evidence: z
    .array(
      z.strictObject({
        source_lineage: identifier,
        locator: text,
        variant_key: text,
        source_observation_id: identifier,
      }),
    )
    .optional(),
};
export const printingRecord = z.strictObject(printingFields).openapi("CandidatePrinting");
export const historicalPrinting = printingRecord
  .omit({ gameplay_applicability: true })
  .openapi("RetainedPreCategoryPrinting");
export const historicalObservedPrinting = historicalPrinting
  .omit({ id: true, card_id: true })
  .openapi("RetainedPreCategoryObservedPrinting");
export const observedPrinting = printingRecord.omit({ id: true, card_id: true }).openapi("CandidateObservedPrinting");
export const imageRecord = z
  .strictObject({
    id: identifier,
    printing_id: identifier,
    role: z.enum(["front", "back", "other"]),
    media_type: z.string().regex(/^image\//),
    width: count,
    height: count,
    content_sha256: digest,
    content_byte_length: count,
    object_key: text,
    source_url: text,
    content_base64: text.optional(),
  })
  .openapi("CandidatePrintingImage");
const region = z.enum(["EN-OCEANIA", "EN-ASIA", "EN-US", "unknown"]);
const precision = z.enum(["day", "month", "quarter", "season", "year", "unknown"]);
const releaseStatus = z.enum(["announced", "released"]);
const productReference = z.strictObject({ kind: z.enum(["official_code", "name"]), value: text });
const productEvidence = z.strictObject({
  type: z.literal("source_observation"),
  id: identifier,
  captured_at: text,
  source: text,
  surface: text.optional(),
  request_role: z.enum(["surface", "listing", "detail", "product_detail", "image"]).optional(),
  authority_class: z
    .enum(["product_detail", "release_schedule", "product_listing", "card_detail", "card_listing", "policy", "unknown"])
    .optional(),
});
const withdrawal = z.strictObject({
  revision_id: identifier.optional(),
  evidence: z.strictObject({
    assertion: z.literal("withdrawn"),
    effective_at: text,
    evidence: text,
    source_lineage: identifier,
    source_snapshot_id: identifier,
    source_observation_set_id: identifier,
    source_observation_id: identifier,
  }),
});
const release = z.strictObject({
  ...curated,
  id: identifier,
  event_key: text,
  product_id: identifier,
  region,
  date: z.strictObject({ precision: precision.nullable(), value: text, tentative: z.literal(true).optional() }),
  status: releaseStatus.nullable(),
});
export const productRecord = z
  .strictObject({
    ...curated,
    reference: productReference,
    id: identifier,
    game,
    official_code: text,
    name: text,
    releases: z.array(release),
    observed: z.boolean(),
    withdrawal: withdrawal.nullable(),
    included: z.array(productEvidence),
    provenance: z.record(z.string(), z.array(z.string())),
    disagreements: z.array(
      z.strictObject({
        path: text,
        status: z.enum(["unresolved", "resolved_by_authority"]),
        candidates: z.array(z.strictObject({ value: sourceValue, observation_id: identifier })),
      }),
    ),
    source_observations: z
      .array(
        z.strictObject({
          reference: productReference,
          id: identifier,
          officialCode: text,
          name: text,
          releases: z.array(
            z.strictObject({
              eventKey: text,
              region,
              precision,
              value: text,
              tentative: z.literal(true).optional(),
              status: releaseStatus.nullable(),
            }),
          ),
          withdrawal: withdrawal.nullable(),
          evidence: productEvidence,
          carriedOfficialCode: z.strictObject({ value: text, evidence: z.array(productEvidence) }).optional(),
        }),
      )
      .optional(),
    membership_evidence: z.strictObject({ sha256: digest, count }).optional(),
  })
  .openapi("CandidateProduct");
const evidenceCategory = z.enum(["explicit", "derived", "curated"]);
const distribution = z.strictObject({
  ...curated,
  id: identifier,
  game,
  key: text,
  kind: z.enum(["product", "tournament_pack", "winner_prize", "promotion", "other"]),
  label: text,
  product_id: identifier.nullable(),
  evidence_category: evidenceCategory,
  observed: z.boolean(),
  source_lineages: z.array(identifier).optional(),
});
const relationship = z.strictObject({
  ...curated,
  id: identifier,
  game,
  kind: relationshipKind,
  from: entityReference,
  to: entityReference,
  evidence_category: evidenceCategory,
  resolution: z.literal("canonical"),
  source_lineage: identifier.optional(),
  source_observation_ids: z.array(identifier),
  relationship_value: text,
  observed: z.boolean(),
});
const erratum = z.strictObject({
  ...curated,
  id: identifier,
  game,
  target_type: z.enum(["card", "printing"]),
  target_id: identifier,
  effective_from: text,
  official_wording: text,
  corrected_value: text,
  provenance: z.array(z.strictObject({ source_lineage: identifier, source_observation_id: identifier })),
});
const correction = z.strictObject({
  id: identifier,
  game,
  entity_kind: z.enum(["card", "printing"]),
  action: z.enum(["merge", "split"]),
  replacement_ids: z.array(identifier),
});
export const candidateWarning = z
  .object({ code: identifier, detail: text.optional() })
  .catchall(sourceValue)
  .openapi("CandidateWarning", {
    description:
      "Warning code plus retained, code-specific provenance and diagnostic facts; these fields are not discarded during inspection.",
  });
export const candidateFactSchemas = {
  cards: cardRecord,
  printings: printingRecord,
  printing_images: imageRecord,
  products: productRecord,
  distribution_contexts: distribution,
  product_relationships: relationship,
  errata: erratum,
  identity_corrections: correction,
  selected_games: game,
  card_observed_games: game,
  product_observed_games: game,
  product_observed_lineages: identifier,
  source_checks: z.strictObject({
    game,
    area: z.enum(["cards-and-printings", "products-and-releases", "errata"]),
    checked_at: text,
  }),
  warnings: candidateWarning,
  shared_warnings: candidateWarning,
};
export const inspectionIntegrity = z.strictObject({
  manifest_prefix: digest,
  partitions: count,
  texts: count,
  images: count,
  complete: z.boolean(),
  sha256: digest,
});
export const inspectionCounts = z.record(
  z.string(),
  z.partialRecord(z.enum(["added", "removed", "carry_forward", "changed", "evidence_only"]), count),
);
export const inspectionSummary = z.strictObject({
  game,
  approval_scope: z.literal("whole_candidate"),
  expected_game_revision_id: identifier,
  integrity: inspectionIntegrity,
  counts: inspectionCounts,
  record_count: count,
  content_partitions: count,
});
const textReference = z
  .strictObject({
    candidate_id: identifier.nullable(),
    preparation_id: identifier.nullable(),
    parts: z.array(textPart),
  })
  .openapi("CandidateInspectionTextReference");
const historicalFactSchemas = { ...candidateFactSchemas, cards: historicalCard, printings: historicalPrinting };
const cardModels = ["categories", "pre_categories"] as const;
const factSchemas = (model: (typeof cardModels)[number]) =>
  model === "categories" ? candidateFactSchemas : historicalFactSchemas;
const cardModelSchema = z.enum(cardModels);
// Aggregate predecessors have no preparation definition pin. Their retained
// before-values may use either complete shape; current after-values stay strict.
const predecessorModels = [...cardModels, "unversioned"] as const;
const predecessorModelSchema = z.enum(predecessorModels).nullable();
const predecessorFactSchema = (kind: "cards" | "printings", model: (typeof predecessorModels)[number] | null) =>
  model === null
    ? z.null()
    : model === "unversioned"
      ? z.union([candidateFactSchemas[kind], historicalFactSchemas[kind], z.null()])
      : z.union([factSchemas(model)[kind], z.null()]);
const partition = (
  kind: string,
  record: z.ZodType,
  model: z.ZodType<(typeof cardModels)[number]> = cardModelSchema,
  predecessorModel: z.ZodType<(typeof predecessorModels)[number] | null> = predecessorModelSchema,
) =>
  z.strictObject({
    candidate_id: identifier,
    manifest_digest: digest,
    expected_game_revision_id: identifier,
    card_model: model,
    predecessor_card_model: predecessorModel,
    kind: z.literal(kind),
    sha256: digest,
    records: z.array(record),
    text_parts: textParts,
  });
const change = (kind: string, after: z.ZodType, before: z.ZodType) =>
  z.strictObject({
    game,
    entity_class: z.literal(kind),
    entity_id: text,
    change: z.enum(["added", "removed", "carry_forward", "changed", "evidence_only"]),
    expected_game_revision_id: identifier,
    before,
    after: z.union([after, z.null()]),
    before_text: textReference,
    after_text: textReference,
  });
// These facts did not change with Card categories. Share their definitions
// across model contexts instead of expanding them in each before/after branch.
const unchangedFacts = Object.entries(candidateFactSchemas)
  .filter(([kind]) => kind !== "cards" && kind !== "printings")
  .map(([kind, schema]) => [kind, schema.openapi(`CandidateFact_${kind}`)] as const);
const unchangedChanges = (hasPredecessor: boolean) =>
  unchangedFacts.map(([kind, schema]) =>
    change(kind, schema, hasPredecessor ? z.union([schema, z.null()]) : z.null()).openapi(
      `CandidateChange_${kind}_${hasPredecessor ? "predecessor" : "spine"}`,
    ),
  );
const changesWithPredecessor = unchangedChanges(true);
const changesFromSpine = unchangedChanges(false);
export const candidatePartitionSchema = z
  .union([
    ...unchangedFacts.map(([kind, schema]) => partition(kind, schema)),
    partition("inspection_summary", inspectionSummary),
    ...cardModels.flatMap((model) => [
      ...(["cards", "printings"] as const).map((kind) => partition(kind, factSchemas(model)[kind], z.literal(model))),
      ...[null, ...predecessorModels].map((predecessor) =>
        partition(
          "inspection",
          z.union([
            ...(["cards", "printings"] as const).map((kind) =>
              change(kind, factSchemas(model)[kind], predecessorFactSchema(kind, predecessor)),
            ),
            ...(predecessor === null ? changesFromSpine : changesWithPredecessor),
          ]),
          z.literal(model),
          z.literal(predecessor),
        ),
      ),
    ]),
  ])
  .openapi("GameCandidatePartition");
