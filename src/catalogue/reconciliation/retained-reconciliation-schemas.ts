import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import { candidateInputSchema } from "./game-candidate-input-schemas";
import {
  candidateFactSchemas,
  historicalCard,
  historicalPrinting,
  textParts,
  candidateWarning,
} from "./game-candidate-record-schemas";

const count = z.number().int().nonnegative();
const retainedFacts = {
  ...candidateFactSchemas,
  cards: z.union([candidateFactSchemas.cards, historicalCard]),
  printings: z.union([candidateFactSchemas.printings, historicalPrinting]),
};
const header = z.strictObject({
  ordinal: count,
  kind: identifier,
  sha256: digest,
  byte_length: count,
  record_count: count,
});
export const retainedInputListSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciliation-input-partitions@1"),
    ingestion_run_id: identifier,
    verified: z.boolean(),
    manifest_digest: digest.nullable(),
    partitions: z.array(header).max(100),
    next_cursor: z.string().nullable(),
  })
  .openapi("RetainedReconciliationInputs");
// Historical routes have no preparation/model discriminator. Reuse the explicit
// current and pre-category inspection shapes without imposing current domain validation.
export const retainedInputSchema = z
  .union(candidateInputSchema.options.map((option) => option.omit({ preparation_id: true, card_model: true })))
  .openapi("RetainedReconciliationInput");
export const retainedPartitionSchema = z
  .union(
    Object.entries(retainedFacts).map(([kind, schema]) =>
      z.strictObject({
        kind: z.literal(kind),
        sha256: digest,
        records: z.array(kind === "cards" || kind === "printings" ? schema : schema.openapi(`CandidateFact_${kind}`)),
        text_parts: textParts,
      }),
    ),
  )
  .openapi("RetainedReconciliationPartition");
export const retainedPartitionListSchema = z
  .strictObject({
    contract: z.literal("card-keepr-candidate-partitions@1"),
    ingestion_run_id: identifier,
    sealed: z.boolean(),
    manifest: z
      .strictObject({
        contract: z.literal("card-keepr-sealed-candidate-manifest@1"),
        sha256: digest,
        partition_count: count,
      })
      .nullable(),
    partitions: z.array(header).max(100),
    next_cursor: z.string().nullable(),
  })
  .openapi("RetainedReconciliationPartitions");
export const retainedTextSchema = z
  .strictObject({
    contract: z.literal("card-keepr-reconciliation-text-chunk@1"),
    ingestion_run_id: identifier,
    text_sha256: digest,
    ordinal: count,
    content: z.string(),
    sha256: digest,
  })
  .openapi("RetainedReconciliationText");
const resultIdentity = { contract: z.literal("card-keepr-card-printing-reconciliation@2"), run_id: identifier };
const retainedResult = z
  .union([
    z.strictObject({
      ...resultIdentity,
      state: z.enum(["awaiting_approval", "failed"]),
      publishable: z.boolean(),
      candidate_digest: digest,
      expected_current_revision_id: identifier,
      source_observation_set_id: identifier,
      cards: z.array(retainedFacts.cards),
      printings: z.array(retainedFacts.printings),
      products: z.array(candidateFactSchemas.products.openapi("CandidateFact_products")),
      errata: z.array(candidateFactSchemas.errata.openapi("CandidateFact_errata")),
      diagnostics: z.array(candidateWarning),
      warnings: z.array(candidateWarning),
    }),
    z.strictObject({
      ...resultIdentity,
      state: z.literal("failed"),
      publishable: z.literal(false),
      cards: z.array(z.unknown()).length(0),
      printings: z.array(z.unknown()).length(0),
      products: z.array(z.unknown()).length(0),
      errata: z.array(z.unknown()).length(0),
      diagnostics: z.array(candidateWarning),
      warnings: z.array(z.unknown()).length(0),
    }),
  ])
  .openapi("RetainedReconciliationResult");
const workflowIdentity = {
  contract: z.literal("card-keepr-reconciliation-workflow@1"),
  ingestion_run_id: identifier,
  expected_current_revision_id: identifier,
  idempotency_key: identifier,
  workflow_instance_id: identifier,
};
export const pendingRetainedWorkflowSchema = z
  .strictObject({
    ...workflowIdentity,
    status: z.enum([
      "queued",
      "running",
      "paused",
      "errored",
      "terminated",
      "waiting",
      "waitingForPause",
      "unknown",
      "abandoned",
    ]),
    output: z.null(),
  })
  .openapi("PendingRetainedReconciliationWorkflow");
export const retainedWorkflowSchema = z
  .union([
    pendingRetainedWorkflowSchema,
    z.strictObject({ ...workflowIdentity, status: z.literal("complete"), output: retainedResult }),
  ])
  .openapi("RetainedReconciliationWorkflow");
