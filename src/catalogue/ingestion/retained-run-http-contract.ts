import { createRoute, z } from "@hono/zod-openapi";
import { boundedJson, digest, problemResponses, problemSchema, secured } from "../../http/openapi";
import { evidenceStatusSchema } from "../source-evidence";
import {
  retainedRunIdentifier,
  retainedRunSchema,
  retainedAdministrationOperationSchema,
  retainedCandidateInspectionSchema,
} from "./retained-run-schemas";
export { retainedRunSchema, retainedAdministrationOperationSchema, retainedCandidateInspectionSchema };
const params = z.strictObject({ run: retainedRunIdentifier });
const key = { idempotency_key: retainedRunIdentifier };
const historical = { tags: ["Historical runs"], security: secured };
const headers = { "Cache-Control": { required: true, schema: { type: "string" as const } } };
const response = <S extends z.ZodType>(schema: S, description: string) => ({
  description,
  headers,
  content: { "application/json": { schema } },
});
const body = <S extends z.ZodType>(schema: S) => ({ required: true, content: { "application/json": { schema } } });
export const retainedRunInspectionSchema = z.union([evidenceStatusSchema, retainedRunSchema]).openapi("RunInspection");
export const retainedRunRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}",
  operationId: "getRetainedRun",
  description:
    "Inspect the current evidence-backed run or its historical publicRun representation. Whole-candidate publication uses the ordinary per-game routes.",
  request: { params },
  responses: {
    200: response(retainedRunInspectionSchema, "Current evidence inspection or decoded historical run."),
    ...problemResponses,
  },
});
export const retainedCandidateRoute = createRoute({
  ...historical,
  method: "get",
  path: "/v1/ingestion-runs/{run}/candidate",
  operationId: "inspectRetainedRunCandidate",
  description:
    "Inspect the historical aggregate candidate header and differences. This is not native whole-candidate approval input.",
  request: { params },
  responses: {
    200: response(
      retainedCandidateInspectionSchema,
      "Retained candidate inspection, including historical definition facts.",
    ),
    ...problemResponses,
  },
});
const complete = response(
  retainedRunSchema,
  "Original immutable run receipt, including exact replay before mutable eligibility and deadline checks.",
);
const pending = response(
  retainedAdministrationOperationSchema,
  "Observe an existing administration claim or matching historical reservation.",
);
export const retainedApprovalRoute = createRoute({
  ...historical,
  method: "post",
  path: "/v1/ingestion-runs/{run}/approval",
  operationId: "observeRetainedRunApproval",
  deprecated: true,
  description:
    "Retired aggregate approval: replay exact retained success/problem, including historical success without a modern idempotency row; observe an existing matching reservation; otherwise return 410 without claiming or publishing. Ordinary approval uses /v1/publications/start.",
  middleware: [boundedJson],
  request: {
    params,
    body: body(
      z.strictObject({ ...key, candidate_digest: digest, expected_current_revision_id: retainedRunIdentifier }),
    ),
  },
  responses: {
    200: complete,
    202: pending,
    410: {
      description: "run_approval_retired: no new claim, reservation, export or publication.",
      headers,
      content: { "application/problem+json": { schema: problemSchema } },
    },
    ...problemResponses,
  },
});
export const retainedRejectionRoute = createRoute({
  ...historical,
  method: "post",
  path: "/v1/ingestion-runs/{run}/rejection",
  operationId: "rejectRetainedRun",
  description:
    "Reject a retained aggregate candidate or replay its original outcome. Native per-game candidates have separate lifecycle operations.",
  middleware: [boundedJson],
  request: { params, body: body(z.strictObject({ ...key, candidate_digest: digest })) },
  responses: { 200: complete, 202: pending, ...problemResponses },
});
export const retainedRetryRoute = createRoute({
  ...historical,
  method: "post",
  path: "/v1/ingestion-runs/{run}/retry",
  operationId: "retryRetainedRun",
  description:
    "Create a linked historical run from an eligible terminal aggregate run. Exact replay returns the original child receipt even after the child changes. Fresh work on obsolete definitions is rejected; evidence-backed collection has its own retry operation.",
  middleware: [boundedJson],
  request: { params, body: body(z.strictObject(key)) },
  responses: { 201: complete, 202: pending, ...problemResponses },
});
export const retainedCleanupRoute = createRoute({
  ...historical,
  method: "post",
  path: "/v1/ingestion-runs/{run}/publication-cleanup",
  operationId: "cleanupRetainedRunPublication",
  description:
    "Retry reference-safe cleanup for an authorized retained historical reservation, or replay the original completion/problem before current cleanup guards.",
  middleware: [boundedJson],
  request: { params, body: body(z.strictObject(key)) },
  responses: { 200: complete, 202: pending, ...problemResponses },
});
