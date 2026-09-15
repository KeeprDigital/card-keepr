import { cleanupSchema, captureCleanupRoute, stagingCleanupRoute, retryCleanupRoute } from "../source-evidence";
import { identityRoutes } from "./identity-routes";
import { gameCandidateRoutes } from "./game-candidate-routes";
import { httpRoute } from "../../http/openapi";
import {
  advancePublicationPreparationRoute,
  publicationPreparationSchema,
  publicationPreparationAcceptanceSchema,
  publicationPreparationStatusRoute,
  publicationPreparationDispatchRoutes,
  publicationArtifactsRoute,
  publicationArtifactsSchema,
  preparedQueryRoute,
  preparedQuerySchema,
  publicationCompositionRoute,
  publicationCompositionSchema,
} from "./publication-preparation-http-contract";
import { publicUrl } from "../../http/public-base";
import {
  startPublicationRoute,
  approvePublicationRoute,
  resumePublicationRoute,
  advancePublicationRoute,
  publicationAcceptanceSchema,
  publicationStatusRoute,
  publicationStatusSchema,
} from "./http-contract";
import { startEvidenceCleanup, retryEvidenceCleanup } from "./evidence-cleanup-dispatch";
import {
  resumeGamePublication,
  startGamePublication,
  advanceGamePublication,
  approveGamePublication,
  inspectPublication,
} from "./game-publication";
import { startPublicationPreparation } from "./publication-preparation-dispatch";
import {
  advancePublicationPreparation,
  inspectPublicationPreparation,
  inspectPublicationArtifacts,
  composePublicationArtifacts,
  inspectPreparedQuery,
} from "./publication-preparation";
import {
  changeReconciliationProgress,
  inspectReconciliationInputs,
  inspectReconciliationInput,
  inspectReconciliationPartitions,
  inspectReconciliationPartition,
  inspectReconciliationProgress,
  inspectReconciliationText,
} from "./reconciliation-progress";
import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import { type CatalogueStore } from "../shared";
import { resumeReconciliationWorkflow, startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes = [
  httpRoute<Context>()(stagingCleanupRoute, async (c) => {
    const input = c.req.valid("json");
    return c.json(
      cleanupSchema.parse(
        await startEvidenceCleanup(
          c.env.env,
          c.req.valid("param").preparation,
          input.idempotency_key,
          input.retention_days,
          c.env.observedAt,
          "staging",
        ),
      ),
      202,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(captureCleanupRoute, async (c) => {
    const input = c.req.valid("json");
    return c.json(
      cleanupSchema.parse(
        await startEvidenceCleanup(
          c.env.env,
          c.req.valid("param").run,
          input.idempotency_key,
          input.retention_days,
          c.env.observedAt,
        ),
      ),
      202,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(retryCleanupRoute, async (c) =>
    c.json(
      cleanupSchema.parse(
        await retryEvidenceCleanup(c.env.env, c.req.valid("param").cleanup, c.req.valid("json").expected_generation),
      ),
      202,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(resumePublicationRoute, async (c) => {
    const result = await resumeGamePublication(
      c.env.env,
      c.req.valid("param").publication,
      c.req.valid("json"),
      c.env.observedAt,
    );
    const status = publicUrl(c.env.base, `/v1/publications/${encodeURIComponent(result.id)}`);
    return c.json(
      publicationAcceptanceSchema.parse({
        ...result,
        contract: "card-keepr-publication-acceptance@1",
        links: { status },
      }),
      202,
      { Location: status, "Retry-After": "2", "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(advancePublicationRoute, async (c) =>
    c.json(
      publicationStatusSchema.parse(
        await advanceGamePublication(
          c.env.env,
          c.req.valid("param").publication,
          c.req.valid("json").generation,
          c.env.observedAt,
        ),
      ),
      200,
    ),
  ),
  httpRoute<Context>()(publicationStatusRoute, async (c) =>
    c.json(
      publicationStatusSchema.parse(await inspectPublication(c.env.env.CATALOGUE_DB, c.req.valid("param").publication)),
      200,
    ),
  ),
  httpRoute<Context>()(startPublicationRoute, async (c) => {
    const approval = await startGamePublication(c.env.env, c.req.valid("json"), c.env.observedAt);
    const status = publicUrl(c.env.base, `/v1/publications/${encodeURIComponent(approval.id)}`);
    const receipt = publicationAcceptanceSchema.parse({
      ...approval,
      contract: "card-keepr-publication-acceptance@1",
      links: { status },
    });
    return c.json(receipt, 202, { Location: status, "Retry-After": "2", "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(approvePublicationRoute, async (c) => {
    const approval = approvePublicationRoute.responses[202].content["application/json"].schema.parse(
      await approveGamePublication(c.env.env.CATALOGUE_DB, c.req.valid("json"), c.env.observedAt),
    );
    const status = publicUrl(c.env.base, `/v1/publications/${encodeURIComponent(approval.id)}`);
    return c.json(approval, 202, { Location: status, "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(preparedQueryRoute, async (c) => {
    const query = c.req.valid("query");
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, value);
    return c.json(
      preparedQuerySchema.parse(
        await inspectPreparedQuery(c.env.env.CATALOGUE_DB, c.req.valid("param").candidate, parameters),
      ),
      200,
    );
  }),
  httpRoute<Context>()(publicationCompositionRoute, async (c) =>
    c.json(
      publicationCompositionSchema.parse(
        await composePublicationArtifacts(c.env.env, c.req.valid("json").candidate_ids),
      ),
      200,
    ),
  ),
  httpRoute<Context>()(publicationPreparationStatusRoute, async (c) =>
    c.json(
      publicationPreparationSchema.parse(
        await inspectPublicationPreparation(c.env.env.CATALOGUE_DB, c.req.valid("param").candidate),
      ),
      200,
    ),
  ),
  httpRoute<Context>()(publicationArtifactsRoute, async (c) =>
    c.json(
      publicationArtifactsSchema.parse(
        await inspectPublicationArtifacts(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").candidate,
          c.req.valid("query").after ?? null,
        ),
      ),
      200,
    ),
  ),
  ...gameCandidateRoutes,
  httpRoute<Context>()(advancePublicationPreparationRoute, async (c) =>
    c.json(
      publicationPreparationSchema.parse(
        await advancePublicationPreparation(
          c.env.env,
          c.req.valid("param").candidate,
          c.req.valid("json"),
          c.env.observedAt,
        ),
      ),
      200,
    ),
  ),
  ...publicationPreparationDispatchRoutes.map((definition) =>
    httpRoute<Context>()(definition, async (c) => {
      const candidate = c.req.valid("param").candidate;
      const input = c.req.valid("json");
      const result = await startPublicationPreparation(
        c.env.env,
        candidate,
        definition.operationId === "resumePublicationPreparation" ? { ...input, resume: true } : input,
        c.env.observedAt,
      );
      const status = publicUrl(
        c.env.base,
        `/v1/game-candidates/${encodeURIComponent(candidate)}/publication-preparation`,
      );
      return c.json(
        publicationPreparationAcceptanceSchema.parse({
          ...result,
          contract: "card-keepr-publication-preparation-acceptance@1",
          links: { status },
        }),
        202,
        { Location: status, "Retry-After": "2", "Cache-Control": "no-store" },
      );
    }),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/text/:digest/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationText(env.CATALOGUE_DB, params.run!, params.digest!, params.ordinal!)),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/inputs", async ({ env, request }, params) =>
    Response.json(
      await inspectReconciliationInputs(env.CATALOGUE_DB, params.run!, new URL(request.url).searchParams.get("after")),
    ),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/inputs/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationInput(env.CATALOGUE_DB, params.run!, params.ordinal!)),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/partitions/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationPartition(env.CATALOGUE_DB, params.run!, params.ordinal!)),
  ),
  ...(["pause", "resume", "abandon"] as const).map((action) =>
    route<Context>(
      "POST",
      `/v1/ingestion-runs/:run/reconciliation/${action}`,
      async ({ env, request, observedAt }, params) => {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["generation", "idempotency_key"]);
        const result = await changeReconciliationProgress(
          env.CATALOGUE_DB,
          params.run!,
          action,
          {
            generation: Number(body.generation),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        );
        if (action === "resume")
          await resumeReconciliationWorkflow(env.CATALOGUE_DB, env.RECONCILIATION_WORKFLOW, params.run!);
        return Response.json(result);
      },
    ),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/partitions", async ({ env, request }, params) => {
    return Response.json(
      await inspectReconciliationPartitions(
        env.CATALOGUE_DB,
        params.run!,
        new URL(request.url).searchParams.get("after"),
      ),
    );
  }),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation", async ({ env }, params) => {
    return Response.json(await inspectReconciliationProgress(env.CATALOGUE_DB, params.run!));
  }),
  ...identityRoutes,
  route<Context>("POST", "/v1/ingestion-runs/:run/reconciliation", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["expected_current_revision_id", "idempotency_key"]);
    const result = await startOrObserveReconciliationWorkflow(
      env.CATALOGUE_DB,
      env.RECONCILIATION_WORKFLOW,
      {
        ingestion_run_id: params.run!,
        expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(result.document, {
      status: result.created && result.document.status !== "complete" ? 202 : 200,
    });
  }),
];
