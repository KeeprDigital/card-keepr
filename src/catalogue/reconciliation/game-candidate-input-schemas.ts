import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";
import {
  candidateWarning,
  imageRecord,
  observedCard,
  observedPrinting,
  historicalObservedCard,
  historicalObservedPrinting,
  officialIdentity,
  sourceValue,
  textParts,
} from "./game-candidate-record-schemas";
const count = z.number().int().nonnegative();
const text = z.string().nullable();
const game = z.enum(gameProfileRegistrations().map(({ game }) => game));
const capability = z.enum(["unavailable", "catalogue", "errata"]);
const observationIdentity = {
  sourceObservationId: identifier,
  sourceObservationSetId: identifier,
  sourceSnapshotId: identifier,
  sourceCapturedAt: text,
  sourceLineage: identifier,
  sourceRequestRole: z.enum(["surface", "listing", "detail", "product_detail", "image"]),
  sourceSurface: text.optional(),
  supportedGame: game,
  structurallyComplete: z.literal(true),
};
const cardObservation = z.strictObject({
  ...observationIdentity,
  kind: z.literal("card_printing"),
  observedCardAndPrinting: z.strictObject({ card: observedCard.nullable(), printing: observedPrinting.nullable() }),
  locator: text,
  variantKey: text,
  artworkFingerprint: text,
  artworkIdentityExplicit: z.boolean(),
  printedFieldsDigest: text,
  treatment: text,
  demonstrablyNovel: z.boolean(),
  noveltyProofComplete: z.boolean(),
  printingImages: z.array(imageRecord.omit({ id: true, printing_id: true, object_key: true })),
  memberships: z.strictObject({
    products: z.array(text),
    distribution_contexts: z.array(text),
    source_buckets: z.array(text),
  }),
  withdrawal: z
    .strictObject({
      entity: z.enum(["card", "printing", "card_and_printing"]),
      state: z.enum(["withdrawn", "reinstated"]),
      effective_at: text,
      evidence: text,
    })
    .nullable(),
  productReleaseValue: sourceValue.optional(),
  sourceWarnings: z.array(candidateWarning),
  errata: z.array(
    z.strictObject({
      targetType: z.enum(["card", "printing"]),
      effectiveFrom: text,
      officialWording: text,
      correctedValue: text,
    }),
  ),
  cardRelationships: z.array(
    z.strictObject({
      kind: z.literal("shared_artwork"),
      target: z.strictObject({ source_lineage: identifier, locator: text, variant_key: text }),
    }),
  ),
});
const erratumObservation = z.strictObject({
  ...observationIdentity,
  kind: z.literal("official_erratum"),
  game,
  target: z.union([
    z.strictObject({ type: z.literal("card"), officialIdentity }),
    z.strictObject({ type: z.literal("printing"), officialIdentity, locator: text }),
  ]),
  publishedOn: text,
  effectiveFrom: text,
  observedPrintedRulesText: text,
  correctedRulesText: text,
  officialWording: text,
  appliesToParallelPrintings: z.boolean(),
  sourceLocator: text,
});
const historicalCardObservation = cardObservation.omit({ cardRelationships: true }).extend({
  observedCardAndPrinting: z.strictObject({
    card: z.union([historicalObservedCard, z.null()]),
    printing: z.union([historicalObservedPrinting, z.null()]),
  }),
});
const inputSchemas = {
  $metadata: z.strictObject({
    values: z.strictObject({
      observationSetId: identifier,
      hasCardErrata: z.boolean(),
      sourceSnapshotId: identifier,
      sourceLineage: identifier,
      supportedGame: game,
      reconciliationCapability: capability,
      structurallyComplete: z.literal(true),
    }),
    array_keys: z.array(
      z.enum(["countChangeWarnings", "unavailablePrintingImages", "partitions", "evidencePlans", "observations"]),
    ),
  }),
  observations: z.union([cardObservation, erratumObservation]),
  countChangeWarnings: candidateWarning,
  unavailablePrintingImages: z.strictObject({
    requestId: identifier,
    sourceUrl: text,
    sourceLineage: identifier,
    failureCode: identifier,
  }),
  partitions: z.strictObject({
    sequenceNumber: count,
    requestId: identifier,
    observationSetId: identifier,
    sourceSnapshotId: identifier,
    sourceLineage: identifier,
    supportedGame: game,
    gameProfileVersion: identifier,
    adapterVersion: identifier,
    capturedAt: text,
    reconciliationCapability: capability,
  }),
  evidencePlans: z.strictObject({
    sourceLineage: identifier,
    supportedGame: game,
    adapterVersion: identifier,
    subset: text,
    printingAdmission: z.enum(["source_qualification", "owner_review"]),
    reconciliationCapability: capability,
    cardIdentities: z.array(z.strictObject({ kind: z.string(), value: text })).optional(),
  }),
};
export const candidateInputSchema = z
  .union(
    (["categories", "pre_categories"] as const).flatMap((model) =>
      Object.entries({
        ...inputSchemas,
        observations: z.union([
          model === "categories" ? cardObservation : historicalCardObservation,
          erratumObservation,
        ]),
      }).map(([kind, schema]) =>
        z.strictObject({
          contract: z.literal("card-keepr-reconciliation-input-partition@1"),
          ingestion_run_id: identifier,
          preparation_id: identifier,
          card_model: z.literal(model),
          ordinal: count,
          kind: z.literal(kind),
          sha256: digest,
          records: z.array(schema),
          text_parts: textParts,
        }),
      ),
    ),
  )
  .openapi("GameCandidateInputPartition");
