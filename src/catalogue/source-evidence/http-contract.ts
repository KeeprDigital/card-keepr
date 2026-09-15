import {
  coverageSchema,
  evidenceInputSchema,
  evidenceAcceptanceSchema,
  evidenceStatusSchema,
  collectionPauseSchema,
  collectionTerminationSchema,
  collectionResumeSchema,
  capacityExtensionSchema,
  observationSetSchema,
} from "./http-evidence-schema";
import type { MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, identifier, problemResponses, secured } from "../../http/openapi";
import { globalEmergencySourceRequestCeiling } from "../adapters";

export const privateResponse: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
};

export const generation = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
export const count = z.number().int().nonnegative();
export const timestamp = z.string().datetime();
export const jsonHeaders = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
export const authorityDecisionSchema = z
  .strictObject({
    game: identifier,
    locale: identifier,
    release_region: identifier,
    area: z.enum(["card_facts", "printing_details", "corrected_card_content"]),
    source_lineage: identifier,
    generation: count,
    rationale: identifier,
    decided_at: timestamp.nullable(),
  })
  .openapi("SourceAuthorityDecision");
export const authoritiesSchema = z.strictObject({ authorities: z.array(authorityDecisionSchema) });
export const authorityInputSchema = authorityDecisionSchema.omit({ generation: true, decided_at: true }).extend({
  expected_generation: generation,
  idempotency_key: identifier,
});
export const authoritiesRoute = createRoute({
  method: "get",
  path: "/v1/source-authorities",
  operationId: "sourceAuthorities",
  security: secured,
  middleware: [privateResponse],
  responses: {
    200: {
      description: "Current exact scope designations; ownership does not imply authority.",
      headers: jsonHeaders,
      content: { "application/json": { schema: authoritiesSchema } },
    },
    ...problemResponses,
  },
});
export const selectAuthorityRoute = createRoute({
  method: "post",
  path: "/v1/source-authorities",
  operationId: "selectSourceAuthority",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: { body: { required: true, content: { "application/json": { schema: authorityInputSchema } } } },
  responses: {
    200: {
      description: "Immutable authority decision, including exact replay.",
      headers: jsonHeaders,
      content: { "application/json": { schema: authorityDecisionSchema } },
    },
    ...problemResponses,
  },
});

export const lifecycleInputSchema = z.strictObject({
  state: z.enum(["active", "retired"]),
  expected_generation: generation,
  rationale: identifier,
  idempotency_key: identifier,
});
export const lifecycleDecisionSchema = lifecycleInputSchema
  .omit({ expected_generation: true })
  .extend({ source_lineage: identifier, generation: count, decided_at: timestamp })
  .openapi("SourceLifecycleDecision");
export const lifecycleSchema = z
  .strictObject({
    source_lineage: identifier,
    state: z.enum(["active", "retired"]),
    generation: count,
    history: z.array(lifecycleDecisionSchema),
  })
  .openapi("SourceLifecycleHistory");
const lineageParams = z.strictObject({ lineage: identifier });
export const lifecycleRoute = createRoute({
  method: "get",
  path: "/v1/source-lineages/{lineage}/lifecycle",
  operationId: "sourceLifecycle",
  security: secured,
  middleware: [privateResponse],
  request: { params: lineageParams },
  responses: {
    200: {
      description: "Current lifecycle and retained decisions.",
      headers: jsonHeaders,
      content: { "application/json": { schema: lifecycleSchema } },
    },
    ...problemResponses,
  },
});
export const decideLifecycleRoute = createRoute({
  method: "post",
  path: "/v1/source-lineages/{lineage}/lifecycle",
  operationId: "decideSourceLifecycle",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: {
    params: lineageParams,
    body: { required: true, content: { "application/json": { schema: lifecycleInputSchema } } },
  },
  responses: {
    200: {
      description: "Immutable lifecycle decision. Retirement retains evidence and cannot transfer authority.",
      headers: jsonHeaders,
      content: { "application/json": { schema: lifecycleDecisionSchema } },
    },
    ...problemResponses,
  },
});

export const registrySchema = z
  .strictObject({
    publishers: z.array(z.strictObject({ id: identifier, name: identifier })),
    sources: z.array(z.strictObject({ id: identifier, name: identifier, publisher_id: identifier.nullable() })),
    lineages: z.array(
      z.strictObject({
        id: identifier,
        source_id: identifier,
        game: identifier,
        locale: z.literal("en"),
        release_region: identifier,
      }),
    ),
    lifecycle: z.array(lifecycleSchema),
    profiles: z.array(
      z.strictObject({
        id: identifier,
        game: identifier,
        publisher_id: identifier,
        schema: z.record(z.string(), z.unknown()).openapi({
          description: "The Game Profile's exported JSON Schema; owned by the shared profile registry.",
          additionalProperties: true,
        }),
      }),
    ),
    adapters: z.array(
      z.strictObject({
        adapter_version: identifier,
        source_lineage: identifier,
        game: identifier,
        game_profile: identifier,
        parser_contract: identifier,
        transport_permission: z.union([
          z.strictObject({ kind: z.literal("credential-free-https") }),
          z.strictObject({ kind: z.literal("exact-url"), url: z.url() }),
        ]),
        coverage_contracts: z.array(
          z.strictObject({ subset: identifier, description: identifier, required_surfaces: z.array(identifier) }),
        ),
        coverage: coverageSchema,
      }),
    ),
    definitions: z.strictObject({
      before_go_live: z.literal("edit_in_place"),
      after_go_live: z.literal("immutable_versions"),
      correction: z.literal("fresh_collection"),
    }),
  })
  .openapi("SourceRegistry");
export const registryRoute = createRoute({
  method: "get",
  path: "/v1/source-registry",
  operationId: "sourceRegistry",
  security: secured,
  middleware: [privateResponse],
  responses: {
    200: {
      description: "Source ownership, lineages, lifecycle, profiles and adapter acquisition scope.",
      headers: jsonHeaders,
      content: { "application/json": { schema: registrySchema } },
    },
    ...problemResponses,
  },
});

const runParams = z.strictObject({ run: identifier });
export const intentSchema = z.strictObject({ idempotency_key: identifier });
const locationHeaders = {
  ...jsonHeaders,
  Location: { required: true, schema: { type: "string" as const, format: "uri" } },
  "Retry-After": { required: true, schema: { type: "string" as const } },
};
export const startEvidenceRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/evidence",
  operationId: "startEvidenceCollection",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: { body: { required: true, content: { "application/json": { schema: evidenceInputSchema } } } },
  responses: {
    201: {
      description:
        "Immutable original collection acceptance, including replay. Collection is not dispatched until resume; poll Location for current status.",
      headers: locationHeaders,
      content: { "application/json": { schema: evidenceAcceptanceSchema } },
    },
    ...problemResponses,
  },
});
export const retryEvidenceRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/collection/retry",
  operationId: "retryEvidenceCollection",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: { params: runParams, body: { required: true, content: { "application/json": { schema: intentSchema } } } },
  responses: {
    201: {
      description:
        "Immutable acceptance of a new linked run. Retains the old terminal run and requires separate resume.",
      headers: locationHeaders,
      content: { "application/json": { schema: evidenceAcceptanceSchema } },
    },
    ...problemResponses,
  },
});
export const evidenceStatusRoute = createRoute({
  method: "get",
  path: "/v1/ingestion-runs/{run}/evidence",
  operationId: "showSourceEvidence",
  security: secured,
  middleware: [privateResponse],
  request: { params: runParams },
  responses: {
    200: {
      description:
        "Current collection, bounded retained evidence, pause/termination, retry and Workflow status. Completion of collection is distinct from publication.",
      headers: jsonHeaders,
      content: { "application/json": { schema: evidenceStatusSchema } },
    },
    ...problemResponses,
  },
});
export const pauseEvidenceRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/collection/pause",
  operationId: "pauseEvidenceCollection",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: { params: runParams, body: { required: true, content: { "application/json": { schema: intentSchema } } } },
  responses: {
    200: {
      description: "Retained owner pause decision; exact replay does not pause a subsequently resumed attempt.",
      headers: jsonHeaders,
      content: { "application/json": { schema: collectionPauseSchema } },
    },
    ...problemResponses,
  },
});
export const terminateEvidenceRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/collection/termination",
  operationId: "terminateEvidenceCollection",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: { params: runParams, body: { required: true, content: { "application/json": { schema: intentSchema } } } },
  responses: {
    200: {
      description:
        "Retained terminal decision and current reservation-release observation. Retained evidence survives; this run cannot resume.",
      headers: jsonHeaders,
      content: { "application/json": { schema: collectionTerminationSchema } },
    },
    ...problemResponses,
  },
});
export const extendCapacityRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/capacity/extension",
  operationId: "extendSourceCapacity",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: {
    params: runParams,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: intentSchema.extend({
            expected_request_capacity: count.min(1),
            expected_capacity_generation: count.min(1),
            request_capacity: count
              .min(1)
              .describe(
                `Absolute per-lineage capacity, greater than the current capacity and below ${globalEmergencySourceRequestCeiling}. A capacity at or above this ceiling returns request_capacity_exceeds_global_ceiling.`,
              ),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Immutable capacity extension; the run stays paused until a separate resume.",
      headers: jsonHeaders,
      content: { "application/json": { schema: capacityExtensionSchema } },
    },
    ...problemResponses,
  },
});
const optionalEmptyJson: typeof boundedJson = async (c, next) => {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return next();
  // A bodyless network POST can expose an empty stream instead of null.
  // Inspect one nonempty chunk, then preserve it for the bounded JSON reader.
  let first = await reader.read();
  while (!first.done && first.value.byteLength === 0) first = await reader.read();
  if (first.done) {
    reader.releaseLock();
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-type");
    c.req.raw = new Request(c.req.raw, { method: c.req.raw.method, headers, body: null });
    return next();
  }
  const initial = first.value;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(initial);
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  c.req.raw = new Request(c.req.raw, { method: c.req.raw.method, body });
  return boundedJson(c, next);
};
export const resumeEvidenceRoute = createRoute({
  method: "post",
  path: "/v1/ingestion-runs/{run}/collection/resume",
  operationId: "resumeEvidenceCollection",
  security: secured,
  middleware: [privateResponse, optionalEmptyJson],
  request: {
    params: runParams,
    body: { required: false, content: { "application/json": { schema: z.strictObject({}).optional() } } },
  },
  responses: {
    202: {
      description:
        "Dispatch acknowledgement with observed Workflow status. Repeating reacquires the current deterministic attempt; it does not prove collection completion. Poll Location.",
      headers: locationHeaders,
      content: { "application/json": { schema: collectionResumeSchema } },
    },
    ...problemResponses,
  },
});

const snapshotParams = z.strictObject({ snapshot: identifier });
const observationParams = z.strictObject({ observationSet: identifier });
export const sourceParsePendingSchema = z
  .strictObject({
    kind: z.literal("pending"),
    source_snapshot_id: identifier,
    adapter_version: identifier,
    parse_operation_id: identifier,
    observation_set_id: identifier,
    phase: z.enum(["decoding", "normalizing"]),
  })
  .openapi("SourceParsePending");

export const reparseRoute = createRoute({
  method: "post",
  path: "/v1/source-snapshots/{snapshot}/observations",
  operationId: "reparseSourceSnapshot",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: {
    params: snapshotParams,
    body: {
      required: true,
      content: { "application/json": { schema: intentSchema.extend({ adapter_version: identifier }) } },
    },
  },
  responses: {
    201: {
      description:
        "Immutable observation set for this parse intent. A different key appends a new interpretation; original bytes remain unchanged.",
      headers: jsonHeaders,
      content: { "application/json": { schema: observationSetSchema } },
    },
    202: {
      description:
        "A bounded parse step retained progress. Repeat this POST with the same snapshot, adapter version and idempotency key until 201 seals the observation set. Retrying the completed intent returns that same immutable set.",
      headers: jsonHeaders,
      content: { "application/json": { schema: sourceParsePendingSchema } },
    },
    ...problemResponses,
  },
});
export const importedRecordsSchema = z.strictObject({
  observation_set_id: identifier,
  state: z.literal("sealed"),
  observation_count: count,
});
export const importRecordsRoute = createRoute({
  method: "post",
  path: "/v1/source-observation-sets/{observationSet}/records",
  operationId: "importRetainedSourceRecords",
  security: secured,
  middleware: [privateResponse, boundedJson],
  request: {
    params: observationParams,
    body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
  },
  responses: {
    200: {
      description:
        "Explicit bounded import or replay of already sealed retained records; original evidence is never rewritten.",
      headers: jsonHeaders,
      content: { "application/json": { schema: importedRecordsSchema } },
    },
    ...problemResponses,
  },
});
const retainedHeaders = {
  "Cache-Control": { required: true, schema: { type: "string" as const } },
  "Content-Length": { required: true, schema: { type: "string" as const, pattern: "^[0-9]+$" } },
  ETag: { required: true, schema: { type: "string" as const } },
};
export const snapshotContentRoute = createRoute({
  method: "get",
  path: "/v1/source-snapshots/{snapshot}/content",
  operationId: "sourceSnapshotContent",
  security: secured,
  request: { params: snapshotParams },
  responses: {
    200: {
      description:
        "Exact retained Source Snapshot bytes streamed with their original media type (or application/octet-stream when unknown). No parsing or buffering at the HTTP boundary.",
      headers: retainedHeaders,
      content: { "*/*": { schema: z.string().openapi({ format: "binary" }) } },
    },
    ...problemResponses,
  },
});
// Retained JSON is an opaque stream at runtime, so use an OpenAPI schema rather
// than Hono's typed c.json response. Additional adapter-owned fields survive.
const observationContentSchema = {
  type: "object" as const,
  required: [
    "contract",
    "id",
    "source_snapshot_id",
    "source_lineage",
    "supported_game",
    "game_profile_version",
    "adapter_version",
    "parsed_at",
  ],
  properties: {
    contract: { type: "string" as const, enum: ["card-keepr-source-observations@1"] },
    ...Object.fromEntries(
      ["id", "source_snapshot_id", "source_lineage", "supported_game", "game_profile_version", "adapter_version"].map(
        (name) => [name, { type: "string" as const, minLength: 1 }],
      ),
    ),
    parsed_at: { type: "string" as const, format: "date-time" },
    record_storage: {
      type: "object" as const,
      required: ["contract", "count", "sha256"],
      properties: {
        contract: { type: "string" as const, enum: ["card-keepr-source-records@1"] },
        count: { type: "integer" as const, minimum: 0 },
        sha256: { type: "string" as const, pattern: "^[a-f0-9]{64}$" },
        requests: {
          type: "object" as const,
          required: ["count", "sha256"],
          properties: {
            count: { type: "integer" as const, minimum: 0 },
            sha256: { type: "string" as const, pattern: "^[a-f0-9]{64}$" },
          },
        },
      },
    },
    observations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["id", "ordinal", "value"],
        properties: { id: { type: "string" as const }, ordinal: { type: "integer" as const, minimum: 1 }, value: {} },
      },
    },
  },
  additionalProperties: true,
  description:
    "Immutable retained manifest or historical inline observations; adapter-owned historical fields are preserved. The HTTP boundary streams original bytes without rewriting or hydrating records.",
};
export const observationContentRoute = createRoute({
  method: "get",
  path: "/v1/source-observation-sets/{observationSet}/content",
  operationId: "sourceObservationSetContent",
  security: secured,
  request: { params: observationParams },
  responses: {
    200: {
      description: "Exact retained JSON streamed from evidence storage, including historical adapter-owned fields.",
      headers: retainedHeaders,
      content: { "application/json": { schema: observationContentSchema } },
    },
    ...problemResponses,
  },
});
