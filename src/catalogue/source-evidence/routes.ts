import { route, type RouteContext } from "../../http/routes";
import {
  extendRunRequestCapacity,
  reparseSourceSnapshot,
  retryEvidenceRun,
  showEvidenceRun,
  sourceObservationSetContent,
  sourceSnapshotContent,
  startEvidenceRun,
} from "./source-evidence";
import { sourceHostPacingIntervalMilliseconds, sourceHostPacingMode } from "./source-evidence-capture";
import type { EvidenceInspectionOptions } from "./source-evidence-repository";
import { pauseEvidenceCollection, resumeEvidenceRun, terminateEvidenceCollection } from "./evidence-administration";
import {
  readAdministrationBody,
  requiredString,
  requiredEvidencePlans,
  requiredSourceRequests,
  assertOnlyFields,
} from "../../http/administration";

type Environment = {
  CATALOGUE_DB: D1Database;
  EVIDENCE_HOST_WORKFLOW: Parameters<typeof pauseEvidenceCollection>[2];
  EVIDENCE_INGESTION_WORKFLOW: Parameters<typeof resumeEvidenceRun>[1];
  EVIDENCE_OBJECTS: R2Bucket;
  SOURCE_HOST_PACING_INTERVAL_MS: string;
  SOURCE_HOST_PACING_MODE: string;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const sourceEvidenceRoutes = [
  route<Context>("POST", "/v1/ingestion-runs/evidence", async ({ request, env, requestId }) => {
    const body = await readAdministrationBody(request);
    if (body.plans !== undefined) {
      assertOnlyFields(body, ["plans", "idempotency_key"]);
      return Response.json(
        await startEvidenceRun(env.CATALOGUE_DB, {
          plans: requiredEvidencePlans(body, "plans"),
          idempotency_key: requiredString(body, "idempotency_key"),
          operational_request_id: requestId,
        }),
        { status: 201 },
      );
    }
    assertOnlyFields(body, ["supported_game", "source_lineage", "adapter_version", "idempotency_key", "requests"]);
    return Response.json(
      await startEvidenceRun(env.CATALOGUE_DB, {
        supported_game: requiredString(body, "supported_game"),
        source_lineage: requiredString(body, "source_lineage"),
        adapter_version: requiredString(body, "adapter_version"),
        idempotency_key: requiredString(body, "idempotency_key"),
        operational_request_id: requestId,
        requests: requiredSourceRequests(body, "requests"),
      }),
      { status: 201 },
    );
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/collection/resume", async ({ env }, params) => {
    return Response.json(await resumeEvidenceRun(env.CATALOGUE_DB, env.EVIDENCE_INGESTION_WORKFLOW, params.run!), {
      status: 202,
    });
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/collection/pause", async ({ request, env }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["idempotency_key"]);
    return Response.json(
      await pauseEvidenceCollection(
        env.CATALOGUE_DB,
        env.EVIDENCE_INGESTION_WORKFLOW,
        env.EVIDENCE_HOST_WORKFLOW,
        params.run!,
        requiredString(body, "idempotency_key"),
      ),
      { status: 200 },
    );
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/collection/termination", async ({ request, env }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["idempotency_key"]);
    return Response.json(
      await terminateEvidenceCollection(
        env.CATALOGUE_DB,
        env.EVIDENCE_INGESTION_WORKFLOW,
        env.EVIDENCE_HOST_WORKFLOW,
        params.run!,
        requiredString(body, "idempotency_key"),
      ),
      { status: 200 },
    );
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/capacity/extension", async ({ request, env }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "expected_request_capacity",
      "expected_capacity_generation",
      "request_capacity",
      "idempotency_key",
    ]);
    return Response.json(
      await extendRunRequestCapacity(env.CATALOGUE_DB, params.run!, {
        expected_request_capacity: body.expected_request_capacity,
        expected_capacity_generation: body.expected_capacity_generation,
        request_capacity: body.request_capacity,
        idempotency_key: requiredString(body, "idempotency_key"),
      }),
      { status: 200 },
    );
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/collection/retry", async ({ request, env, requestId }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["idempotency_key"]);
    return Response.json(
      await retryEvidenceRun(env.CATALOGUE_DB, params.run!, requiredString(body, "idempotency_key"), requestId),
      { status: 201 },
    );
  }),
  route<Context>("POST", "/v1/source-snapshots/:snapshot/observations", async ({ request, env }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["adapter_version", "idempotency_key"]);
    return Response.json(
      await reparseSourceSnapshot(
        env.CATALOGUE_DB,
        env.EVIDENCE_OBJECTS,
        params.snapshot!,
        requiredString(body, "adapter_version"),
        requiredString(body, "idempotency_key"),
      ),
      { status: 201 },
    );
  }),
  route<Context>("GET", "/v1/source-snapshots/:snapshot/content", async ({ env }, params) => {
    return sourceSnapshotContent(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, params.snapshot!);
  }),
  route<Context>("GET", "/v1/source-observation-sets/:observationSet/content", async ({ env }, params) => {
    return sourceObservationSetContent(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, params.observationSet!);
  }),
  route<Context>("GET", "/v1/ingestion-runs/:run/evidence", async ({ env }, params) => {
    return Response.json(await showEvidenceRun(env.CATALOGUE_DB, params.run!, evidenceInspectionOptions(env)));
  }),
];

export function evidenceInspectionOptions(
  env: Pick<
    Environment,
    | "EVIDENCE_INGESTION_WORKFLOW"
    | "EVIDENCE_HOST_WORKFLOW"
    | "SOURCE_HOST_PACING_MODE"
    | "SOURCE_HOST_PACING_INTERVAL_MS"
  >,
): EvidenceInspectionOptions {
  return {
    parentWorkflow: env.EVIDENCE_INGESTION_WORKFLOW,
    hostWorkflow: env.EVIDENCE_HOST_WORKFLOW,
    pacing: {
      mode: sourceHostPacingMode(env.SOURCE_HOST_PACING_MODE),
      interval_ms: sourceHostPacingIntervalMilliseconds(env.SOURCE_HOST_PACING_INTERVAL_MS),
    },
  };
}
