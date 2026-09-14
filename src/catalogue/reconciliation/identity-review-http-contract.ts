import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, identifier, problemResponses, secured } from "../../http/openapi";
import { mappingEvidence, compatibility } from "./game-candidate-evidence-schemas";
import {
  observedCard,
  observedPrinting,
  historicalObservedCard,
  historicalObservedPrinting,
} from "./game-candidate-record-schemas";
import { candidateStatusSchema } from "./game-candidate-http-contract";

const text = z.string().nullable();
const page = z.strictObject({ after: z.string().optional(), preparation_id: identifier.optional() });
const mapping = z.strictObject({
  entity_id: identifier,
  entity_kind: z.enum(["card", "printing"]),
  source_lineage: identifier,
  ingestion_run_id: identifier,
  source_snapshot_id: identifier,
  source_observation_set_id: identifier,
  source_observation_id: identifier,
  locator: text,
  variant_key: text,
  mapped_at: z.iso.datetime(),
  evidence: mappingEvidence,
  preparation_id: identifier.optional(),
  publication_state: candidateStatusSchema.shape.state.optional(),
});
export const identityInspectionSchema = z
  .strictObject({
    id: identifier,
    kind: z.enum(["card", "printing"]),
    allocation: z.enum(["opaque", "previously_published"]),
    mappings: z.array(mapping).max(100),
    next_cursor: identifier.nullable(),
  })
  .openapi("CanonicalIdentityInspection");
const reviewEvidenceFor = (
  card: typeof observedCard | typeof historicalObservedCard,
  printing: typeof observedPrinting | typeof historicalObservedPrinting,
) =>
  z.union([
    z.strictObject({ card, printing, locator: text, variant_key: text, compatibility }),
    z.strictObject({
      card,
      printing,
      locator: text,
      variant_key: text,
      artwork_fingerprint: text,
      printed_fields_digest: text,
      treatment: text,
    }),
  ]);
const reviewEvidence = z
  .union([
    reviewEvidenceFor(observedCard, observedPrinting),
    reviewEvidenceFor(historicalObservedCard, historicalObservedPrinting),
  ])
  .openapi("RetainedIdentityReviewEvidence");
export const identityReviewsSchema = z
  .strictObject({
    reviews: z
      .array(
        z.strictObject({
          id: identifier,
          source_lineage: identifier,
          created_at: z.iso.datetime(),
          ingestion_run_id: identifier,
          source_observation_id: identifier,
          source_snapshot_id: identifier,
          preparation_id: identifier.optional(),
          candidate_printing_ids: z.array(identifier),
          evidence: reviewEvidence,
        }),
      )
      .max(100),
    next_cursor: identifier.nullable(),
  })
  .openapi("IdentityReviewList");
export const identityDecisionSchema = z
  .strictObject({
    review_id: identifier,
    printing_id: identifier,
    rationale: identifier,
    idempotency_key: identifier,
    request_json: identifier,
    decided_at: z.iso.datetime(),
  })
  .openapi("IdentityReviewDecision");
const headers = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
export const inspectIdentityRoute = createRoute({
  method: "get",
  path: "/v1/reconciliation/identities/{identity}",
  operationId: "inspectCanonicalIdentity",
  security: secured,
  request: { params: z.strictObject({ identity: identifier }), query: page },
  responses: {
    200: {
      description: "Retained canonical mappings, or exact preparation-scoped mappings and candidate state.",
      headers,
      content: { "application/json": { schema: identityInspectionSchema } },
    },
    ...problemResponses,
  },
});
export const listIdentityReviewsRoute = createRoute({
  method: "get",
  path: "/v1/reconciliation/identity-reviews",
  operationId: "inspectIdentityReviews",
  security: secured,
  request: {
    query: page
      .extend({ run_id: identifier.optional() })
      .refine((query) => query.run_id !== undefined || query.preparation_id !== undefined, {
        message: "Select a run_id or preparation_id.",
      }),
  },
  responses: {
    200: {
      description: "Retained evidence requiring explicit owner resolution, selected by preparation or collection.",
      headers,
      content: { "application/json": { schema: identityReviewsSchema } },
    },
    ...problemResponses,
  },
});
export const resolveIdentityRoute = createRoute({
  method: "post",
  path: "/v1/reconciliation/identity-reviews/{review}/resolve",
  operationId: "resolveIdentityReview",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: z.strictObject({ review: identifier }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({ printing_id: identifier, rationale: identifier, idempotency_key: identifier }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Immutable evidence-backed decision, including exact replay. A changed resolution conflicts and this response does not approve publication.",
      headers,
      content: { "application/json": { schema: identityDecisionSchema } },
    },
    ...problemResponses,
  },
});
const history = {
  first_revision_id: identifier,
  last_observed_revision_id: identifier,
  current: z.boolean(),
  last_missing_revision_id: identifier.nullable(),
};
const locator = z.strictObject({ ...history, source_lineage: identifier, locator: identifier, variant_key: text });
const membershipHistory = z.strictObject({ ...history, id: identifier, current: z.literal(false) });
const membershipLists = <T extends z.ZodType>(item: T) =>
  z.strictObject({
    products: z.array(item),
    distribution_contexts: z.array(item),
    source_buckets: z.array(item),
  });
export const reconciledPrintingSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciled-printing@1"),
    id: identifier,
    card_id: identifier,
    locators: z.strictObject({ current: z.array(locator), historical: z.array(locator) }),
    memberships: z.strictObject({
      current: membershipLists(identifier),
      historical: membershipLists(membershipHistory),
    }),
    relationship_evidence: z.array(
      z.strictObject({
        ...history,
        source_lineage: identifier,
        relationship_kind: z.enum(["product", "distribution_context"]),
        relationship_value: identifier,
        source_observation_ids: z.array(identifier),
      }),
    ),
    lifecycle: z.strictObject({
      first_revision_id: identifier,
      last_observed_revision_id: identifier,
      withdrawn: z.boolean(),
      withdrawal: z
        .strictObject({
          revision_id: identifier.nullable(),
          evidence: z.strictObject({
            entity: z.enum(["card", "printing", "card_and_printing"]),
            state: z.enum(["withdrawn", "reinstated"]),
            assertion: z.enum(["withdrawn", "reinstated"]),
            effective_at: z.string(),
            evidence: z.string(),
            source_lineage: identifier,
            source_snapshot_id: identifier,
            source_observation_set_id: identifier,
            source_observation_id: identifier,
          }),
        })
        .nullable(),
    }),
  })
  .openapi("ReconciledPrintingInspection");
export const inspectReconciledPrintingRoute = createRoute({
  method: "get",
  path: "/v1/reconciliation/printings/{printing}",
  operationId: "showReconciledPrinting",
  security: secured,
  request: { params: z.strictObject({ printing: identifier }) },
  responses: {
    200: {
      description:
        "Accepted longitudinal locator, membership and withdrawal evidence without changing canonical identity.",
      headers,
      content: { "application/json": { schema: reconciledPrintingSchema } },
    },
    ...problemResponses,
  },
});
