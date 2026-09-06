import { sourceAuthorities, selectSourceAuthority } from "./source-authority";
import { publishers, sources, sourceLineages, gameProfileRegistrations, sourceAdapterRegistrations } from "../adapters";
import {
  assertOnlyFields,
  readAdministrationBody,
  requiredEvidencePlans,
  requiredSourceRequests,
  requiredString,
} from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { pauseEvidenceCollection, resumeEvidenceRun, terminateEvidenceCollection } from "./evidence-administration";
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

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  EVIDENCE_HOST_WORKFLOW: Parameters<typeof pauseEvidenceCollection>[2];
  EVIDENCE_INGESTION_WORKFLOW: Parameters<typeof resumeEvidenceRun>[1];
  EVIDENCE_OBJECTS: R2Bucket;
  SOURCE_HOST_PACING_INTERVAL_MS: string;
  SOURCE_HOST_PACING_MODE: string;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const sourceEvidenceRoutes = [
  route<Context>("GET", "/v1/source-authorities", async ({ env }) =>
    Response.json(await sourceAuthorities(env.CATALOGUE_DB)),
  ),
  route<Context>("POST", "/v1/source-authorities", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    const fields = [
      "game",
      "locale",
      "release_region",
      "area",
      "source_lineage",
      "expected_generation",
      "rationale",
      "idempotency_key",
    ];
    assertOnlyFields(body, fields);
    const input = Object.fromEntries(fields.map((field) => [field, requiredString(body, field)]));
    return Response.json(await selectSourceAuthority(env.CATALOGUE_DB, input, observedAt));
  }),
  route<Context>("GET", "/v1/source-registry", async () =>
    Response.json({
      publishers,
      sources,
      lineages: sourceLineages,
      profiles: gameProfileRegistrations(),
      adapters: sourceAdapterRegistrations.map(
        ({ adapterVersion, sourceLineage, supportedGame, gameProfileVersion, parserContract, requestSurface }) => ({
          adapter_version: adapterVersion,
          source_lineage: sourceLineage,
          game: supportedGame,
          game_profile: gameProfileVersion,
          parser_contract: parserContract,
          transport_permission: requestSurface,
        }),
      ),
      definitions: {
        before_go_live: "edit_in_place",
        after_go_live: "immutable_versions",
        correction: "fresh_collection",
      },
    }),
  ),
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
    return Response.json(
      await resumeEvidenceRun(
        env.CATALOGUE_DB,
        env.EVIDENCE_INGESTION_WORKFLOW,
        params.run!,
        env.EVIDENCE_HOST_WORKFLOW,
      ),
      {
        status: 202,
      },
    );
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
