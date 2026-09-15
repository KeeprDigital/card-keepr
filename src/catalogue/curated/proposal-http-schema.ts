import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { registeredSupportedGames, sourceValue } from "../shared";

const game = z.enum(registeredSupportedGames());
// Curated evidence/target identities have no generic storage-ID length ceiling;
// owner idempotency keys only require a nonempty string.
export const curatedIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
// Only objects the legacy Curated guard could acknowledge gain an explicit
// empty-name extension branch. Fresh decisions still use the strict schema.
function historicalObject<T extends z.ZodRawShape>(shape: T) {
  return z.union([z.strictObject(shape), z.looseObject({ ...shape, "": sourceValue })]);
}
function proposalSchemas(partitioned: boolean) {
  const date = z.iso.date().nullable();
  const interval = z.strictObject({ from: date, to: date });
  const field = z.strictObject({
    kind: z.literal("field"),
    entity_type: z.enum(["card", "printing", "product", "release", "distribution_context", "erratum"]),
    entity_id: curatedIdentity,
    path: partitioned ? z.string().nullable() : z.string().regex(/^\/(?:[^~]|~[01])+$/),
  });
  const endpoint = z.strictObject({
    type: z.enum(["card", "printing", "product", "distribution_context"]),
    id: curatedIdentity,
  });
  const relationship = z.strictObject({
    kind: z.literal("relationship"),
    relationship_kind: z.enum([
      "printing-product",
      "printing-distribution-context",
      "distribution-context-product",
      "product-card",
    ]),
    from: endpoint,
    to: endpoint,
  });
  const fieldAssertion = z.strictObject({ kind: z.literal("field"), value: sourceValue });
  const relationshipAssertion = z.strictObject({
    kind: z.literal("relationship"),
    presence: z.enum(["present", "absent"]),
  });
  const evidence = z
    .array(
      z.union([
        z.strictObject({ kind: z.literal("source_observation"), id: curatedIdentity }),
        z.strictObject({
          kind: z.literal("owner_reference"),
          uri: partitioned ? z.string().nullable() : z.url(),
          content_digest: digest,
        }),
      ]),
    )
    .min(1);
  const proposalFields = {
    game,
    target: z.union([field, relationship]),
    assertion: z.union([fieldAssertion, relationshipAssertion]),
    rationale: partitioned ? z.string().nullable() : identifier.refine((value) => value.trim().length > 0),
    evidence,
    effective_interval: interval,
    reviewed_source_digest: digest,
    supersedes_revision_id: curatedIdentity.nullable(),
  };
  const historicalRelationship = historicalObject({
    ...relationship.shape,
    from: historicalObject(endpoint.shape),
    to: historicalObject(endpoint.shape),
  });
  const retained = historicalObject({
    ...proposalFields,
    target: z.union([field, historicalRelationship]),
    assertion: z.union([historicalObject(fieldAssertion.shape), historicalObject(relationshipAssertion.shape)]),
    effective_interval: historicalObject(interval.shape),
  });
  return { current: z.strictObject(proposalFields), retained };
}

const owner = proposalSchemas(false);
export const curatedProposalSchema = owner.current.openapi("CuratedRevisionProposal");
export const retainedCuratedProposalSchema = owner.retained.openapi("RetainedCuratedRevisionProposal");
// Candidate evidence replaces long text with null and separate text descriptors.
export const partitionedCuratedProposalSchema = proposalSchemas(true).retained.openapi(
  "PartitionedCuratedRevisionProposal",
);
