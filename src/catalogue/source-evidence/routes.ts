import {
  reparseRoute,
  importRecordsRoute,
  importedRecordsSchema,
  snapshotContentRoute,
  observationContentRoute,
  startEvidenceRoute,
  retryEvidenceRoute,
  evidenceStatusRoute,
  pauseEvidenceRoute,
  terminateEvidenceRoute,
  extendCapacityRoute,
  resumeEvidenceRoute,
  lifecycleRoute,
  lifecycleSchema,
  decideLifecycleRoute,
  lifecycleDecisionSchema,
  registryRoute,
  registrySchema,
  authoritiesRoute,
  authoritiesSchema,
  selectAuthorityRoute,
  authorityDecisionSchema,
} from "./http-contract";
import {
  observationSetSchema,
  evidenceAcceptanceSchema,
  evidenceStatusSchema,
  collectionPauseSchema,
  collectionTerminationSchema,
  collectionResumeSchema,
  capacityExtensionSchema,
} from "./http-evidence-schema";
import { publicUrl } from "../../http/public-base";
import { httpRoute, streamingHttpRoute } from "../../http/openapi";
import { importRetainedSourceRecords } from "./source-record-migration";
import { advanceStagingCleanup } from "./staging-cleanup";
import { inspectEvidenceCleanup, inspectEvidenceCleanupResults, advanceEvidenceCleanup } from "./evidence-cleanup";
import { sourceLifecycleHistory, decideSourceLifecycle } from "./source-lifecycle";
import { sourceAuthorities, selectSourceAuthority } from "./source-authority";
import { publishers, sources, sourceLineages, gameProfileRegistrations, sourceAdapterRegistrations } from "../adapters";
import { assertOnlyFields, readAdministrationBody } from "../../http/administration";
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
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
  SOURCE_HOST_PACING_INTERVAL_MS: string;
  SOURCE_HOST_PACING_MODE: string;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const sourceEvidenceRoutes = [
  httpRoute<Context>()(importRecordsRoute, async (c) =>
    c.json(
      importedRecordsSchema.parse(
        await importRetainedSourceRecords(
          c.env.env.CATALOGUE_DB,
          c.env.env.EVIDENCE_OBJECTS,
          c.req.valid("param").observationSet,
        ),
      ),
      200,
    ),
  ),
  route<Context>("GET", "/v1/evidence-cleanups/:cleanup/objects", async ({ env, request }, params) =>
    Response.json(
      await inspectEvidenceCleanupResults(
        env.CATALOGUE_DB,
        params.cleanup!,
        new URL(request.url).searchParams.get("after") ?? "",
      ),
    ),
  ),
  route<Context>("GET", "/v1/evidence-cleanups/:cleanup", async ({ env }, params) =>
    Response.json(await inspectEvidenceCleanup(env.CATALOGUE_DB, params.cleanup!)),
  ),
  route<Context>("POST", "/v1/evidence-cleanups/:cleanup/advance", async ({ request, env, observedAt }, params) => {
    assertOnlyFields(await readAdministrationBody(request), []);
    const intent = await inspectEvidenceCleanup(env.CATALOGUE_DB, params.cleanup!);
    return Response.json(
      await (intent.scope === "staging"
        ? advanceStagingCleanup(env.CATALOGUE_DB, env, params.cleanup!, observedAt)
        : advanceEvidenceCleanup(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, params.cleanup!, observedAt)),
    );
  }),
  httpRoute<Context>()(lifecycleRoute, async (c) =>
    c.json(
      lifecycleSchema.parse(await sourceLifecycleHistory(c.env.env.CATALOGUE_DB, c.req.valid("param").lineage)),
      200,
    ),
  ),
  httpRoute<Context>()(decideLifecycleRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      lifecycleDecisionSchema.parse(
        await decideSourceLifecycle(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").lineage,
          { ...body, expected_generation: String(body.expected_generation) },
          c.env.observedAt,
        ),
      ),
      200,
    );
  }),
  httpRoute<Context>()(authoritiesRoute, async (c) =>
    c.json(authoritiesSchema.parse(await sourceAuthorities(c.env.env.CATALOGUE_DB)), 200),
  ),
  httpRoute<Context>()(selectAuthorityRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      authorityDecisionSchema.parse(
        await selectSourceAuthority(
          c.env.env.CATALOGUE_DB,
          { ...body, expected_generation: String(body.expected_generation) },
          c.env.observedAt,
        ),
      ),
      200,
    );
  }),
  httpRoute<Context>()(registryRoute, async (c) =>
    c.json(
      registrySchema.parse({
        publishers,
        sources,
        lineages: sourceLineages,
        lifecycle: await Promise.all(
          sourceLineages.map(({ id }) => sourceLifecycleHistory(c.env.env.CATALOGUE_DB, id)),
        ),
        profiles: gameProfileRegistrations(),
        adapters: sourceAdapterRegistrations.map(
          ({
            adapterVersion,
            sourceLineage,
            supportedGame,
            gameProfileVersion,
            parserContract,
            requestSurface,
            reconciliationCapability,
            coverageContracts,
          }) => ({
            adapter_version: adapterVersion,
            source_lineage: sourceLineage,
            game: supportedGame,
            game_profile: gameProfileVersion,
            parser_contract: parserContract,
            transport_permission: requestSurface,
            coverage_contracts: Object.entries(coverageContracts ?? {}).map(([subset, contract]) => ({
              subset,
              description: contract.description,
              required_surfaces: contract.requiredSurfaces,
            })),
            coverage: { locale: "en", area: reconciliationCapability, subset: "complete" },
          }),
        ),
        definitions: {
          before_go_live: "edit_in_place",
          after_go_live: "immutable_versions",
          correction: "fresh_collection",
        },
      }),
      200,
    ),
  ),
  httpRoute<Context>()(startEvidenceRoute, async (c) => {
    const result = await startEvidenceRun(c.env.env.CATALOGUE_DB, {
      ...c.req.valid("json"),
      operational_request_id: c.env.requestId,
    });
    const receipt = evidenceAcceptance(result, c.env.base);
    c.header("Location", receipt.links.status);
    c.header("Retry-After", "1");
    return c.json(receipt, 201);
  }),
  httpRoute<Context>()(retryEvidenceRoute, async (c) => {
    const result = await retryEvidenceRun(
      c.env.env.CATALOGUE_DB,
      c.req.valid("param").run,
      c.req.valid("json").idempotency_key,
      c.env.requestId,
    );
    const receipt = evidenceAcceptance(result, c.env.base);
    c.header("Location", receipt.links.status);
    c.header("Retry-After", "1");
    return c.json(receipt, 201);
  }),
  httpRoute<Context>()(resumeEvidenceRoute, async (c) => {
    const env = c.env.env;
    const run = c.req.valid("param").run;
    const result = await resumeEvidenceRun(
      env.CATALOGUE_DB,
      env.EVIDENCE_INGESTION_WORKFLOW,
      run,
      env.EVIDENCE_HOST_WORKFLOW,
    );
    const status = publicUrl(c.env.base, `/v1/ingestion-runs/${encodeURIComponent(run)}/evidence`);
    c.header("Location", status);
    c.header("Retry-After", "1");
    return c.json(
      collectionResumeSchema.parse({ ...result, contract: "card-keepr-collection-dispatch@1", links: { status } }),
      202,
    );
  }),
  httpRoute<Context>()(pauseEvidenceRoute, async (c) => {
    const env = c.env.env;
    return c.json(
      collectionPauseSchema.parse(
        await pauseEvidenceCollection(
          env.CATALOGUE_DB,
          env.EVIDENCE_INGESTION_WORKFLOW,
          env.EVIDENCE_HOST_WORKFLOW,
          c.req.valid("param").run,
          c.req.valid("json").idempotency_key,
        ),
      ),
      200,
    );
  }),
  httpRoute<Context>()(terminateEvidenceRoute, async (c) => {
    const env = c.env.env;
    return c.json(
      collectionTerminationSchema.parse(
        await terminateEvidenceCollection(
          env.CATALOGUE_DB,
          env.EVIDENCE_INGESTION_WORKFLOW,
          env.EVIDENCE_HOST_WORKFLOW,
          c.req.valid("param").run,
          c.req.valid("json").idempotency_key,
        ),
      ),
      200,
    );
  }),
  httpRoute<Context>()(extendCapacityRoute, async (c) =>
    c.json(
      capacityExtensionSchema.parse(
        await extendRunRequestCapacity(c.env.env.CATALOGUE_DB, c.req.valid("param").run, c.req.valid("json")),
      ),
      200,
    ),
  ),
  httpRoute<Context>()(reparseRoute, async (c) => {
    const body = c.req.valid("json");
    return c.json(
      observationSetSchema.parse(
        await reparseSourceSnapshot(
          c.env.env.CATALOGUE_DB,
          c.env.env.EVIDENCE_OBJECTS,
          c.req.valid("param").snapshot,
          body.adapter_version,
          body.idempotency_key,
        ),
      ),
      201,
    );
  }),
  streamingHttpRoute<Context>()(snapshotContentRoute, async (c) =>
    sourceSnapshotContent(c.env.env.CATALOGUE_DB, c.env.env.EVIDENCE_OBJECTS, c.req.valid("param").snapshot),
  ),
  streamingHttpRoute<Context>()(observationContentRoute, async (c) =>
    sourceObservationSetContent(
      c.env.env.CATALOGUE_DB,
      c.env.env.EVIDENCE_OBJECTS,
      c.req.valid("param").observationSet,
    ),
  ),
  httpRoute<Context>()(evidenceStatusRoute, async (c) =>
    c.json(
      evidenceStatusSchema.parse(
        await showEvidenceRun(c.env.env.CATALOGUE_DB, c.req.valid("param").run, evidenceInspectionOptions(c.env.env)),
      ),
      200,
    ),
  ),
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

/** Project only immutable retained facts; a replay never substitutes current lifecycle state. */
function evidenceAcceptance(result: Record<string, unknown>, base: Context["base"]) {
  const id = result.id;
  if (typeof id !== "string") throw new Error("Evidence acceptance requires a retained run identity.");
  return evidenceAcceptanceSchema.parse({
    contract: "card-keepr-evidence-acceptance@1",
    id,
    state: "collecting",
    idempotency_key: result.idempotency_key,
    linked_run_id: result.linked_run_id,
    started_at: result.started_at,
    selected_games: result.selected_games,
    evidence_plans: result.evidence_plans,
    links: { status: publicUrl(base, `/v1/ingestion-runs/${encodeURIComponent(id)}/evidence`) },
  });
}
