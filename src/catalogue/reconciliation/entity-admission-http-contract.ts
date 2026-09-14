import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, identifier, problemResponses, secured } from "../../http/openapi";
import { gameProfileRegistrations } from "../adapters";
import { admission } from "./game-candidate-evidence-schemas";
import { sourceValue } from "./game-candidate-record-schemas";

const game = z.enum(gameProfileRegistrations().map(({ game }) => game));
const count = z.number().int().nonnegative();
export const historyCursor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
// Intake intentionally retains incomplete owner facts and source-defined evidence for review.
const intakeObject = z.record(z.string(), sourceValue);
const intake = z.strictObject({ content: intakeObject, evidence: intakeObject });
const proposalParams = z.strictObject({ proposal: identifier });
const proposalSummary = z.strictObject({
  id: identifier,
  game,
  source_lineage: identifier,
  reference: identifier,
  status: z.enum(["unresolved", "rejected", "admitted"]),
  generation: count,
});
export const entityProposalSchema = proposalSummary
  .extend({
    content: intakeObject,
    evidence: intakeObject,
    initial_intake: intake,
    next_history_cursor: count.nullable(),
    history: z
      .array(
        z.strictObject({
          proposal_id: identifier,
          generation: count,
          action: z.enum(["admit", "link", "reject", "reconsider"]),
          actor: z.enum(["owner", "automation"]),
          rationale: identifier,
          idempotency_key: identifier,
          decided_at: z.iso.datetime(),
          decision: admission,
        }),
      )
      .max(100),
  })
  .openapi("EntityProposalInspection");
const proposalResponse = {
  description:
    "Current proposal inspection. Exact replay retains the original intake/decision and observes current status; no candidate is approved or published.",
  headers: { "Cache-Control": { required: true, schema: { type: "string" as const } } },
  content: { "application/json": { schema: entityProposalSchema } },
};
export const createEntityProposalRoute = createRoute({
  method: "post",
  path: "/v1/entity-proposals",
  operationId: "createEntityProposal",
  security: secured,
  middleware: [boundedJson],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: intake.extend({
            game,
            source_lineage: identifier,
            reference: identifier,
            idempotency_key: identifier,
          }),
        },
      },
    },
  },
  responses: { 201: proposalResponse, ...problemResponses },
});
export const inspectEntityProposalRoute = createRoute({
  method: "get",
  path: "/v1/entity-proposals/{proposal}",
  operationId: "inspectEntityProposal",
  security: secured,
  request: { params: proposalParams, query: z.strictObject({ after_generation: historyCursor.optional() }) },
  responses: { 200: proposalResponse, ...problemResponses },
});
export const decideEntityProposalRoute = createRoute({
  method: "post",
  path: "/v1/entity-proposals/{proposal}/decisions",
  operationId: "decideEntityProposal",
  security: secured,
  middleware: [boundedJson],
  request: {
    params: proposalParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.strictObject({
            action: z.enum(["admit", "link", "reject", "reconsider"]),
            expected_generation: historyCursor,
            rationale: identifier,
            idempotency_key: identifier,
            exception: z
              .strictObject({ scope: z.array(z.enum(["source_evidence", "identity"])), attestation: identifier })
              .optional(),
            card_id: identifier.optional(),
            printing_id: identifier.optional(),
            content: z.union([intakeObject, z.null()]).optional(),
            evidence: z.union([intakeObject, z.null()]).optional(),
          }),
        },
      },
    },
  },
  responses: { 200: proposalResponse, ...problemResponses },
});

export const entityProposalsSchema = z
  .strictObject({
    proposals: z.array(proposalSummary).max(100),
    next_cursor: identifier.nullable(),
  })
  .openapi("EntityProposalList");
export const listEntityProposalsRoute = createRoute({
  method: "get",
  path: "/v1/entity-proposals",
  operationId: "listEntityProposals",
  security: secured,
  request: { query: z.strictObject({ game, after: z.string().optional() }) },
  responses: {
    200: { ...proposalResponse, content: { "application/json": { schema: entityProposalsSchema } } },
    ...problemResponses,
  },
});
export const proposalEvidenceSchema = z
  .strictObject({
    evidence: z
      .array(
        z.strictObject({
          ingestion_run_id: identifier,
          source_snapshot_id: identifier,
          source_observation_id: identifier,
        }),
      )
      .max(100),
    next_cursor: identifier.nullable(),
  })
  .openapi("EntityProposalSourceEvidence");
export const proposalEvidenceRoute = createRoute({
  method: "get",
  path: "/v1/entity-proposals/{proposal}/evidence",
  operationId: "inspectProposalSourceEvidence",
  security: secured,
  request: { params: proposalParams, query: z.strictObject({ after: z.string().optional() }) },
  responses: {
    200: { ...proposalResponse, content: { "application/json": { schema: proposalEvidenceSchema } } },
    ...problemResponses,
  },
});
