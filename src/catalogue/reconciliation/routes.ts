import type { HttpRoute } from "../../http/openapi";
import {
  retainedReconciliationActionRoutes,
  retainedReconciliationStatusSchema,
  retainedReconciliationStatusRoute,
  retainedReconciliationStartRoute,
  retainedWorkflowSchema,
  pendingRetainedWorkflowSchema,
  retainedInputListRoute,
  retainedInputListSchema,
  retainedInputRoute,
  retainedInputSchema,
  retainedPartitionListRoute,
  retainedPartitionListSchema,
  retainedPartitionRoute,
  retainedPartitionSchema,
  retainedTextRoute,
  retainedTextSchema,
} from "./retained-run-http-contract";
import { cleanupSchema, captureCleanupRoute, stagingCleanupRoute, retryCleanupRoute } from "../source-evidence";
import { identityRoutes } from "./identity-routes";
import { gameCandidateRoutes } from "./game-candidate-routes";
import { httpRoute, retainedWireValue } from "../../http/openapi";
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
import { type RouteContext } from "../../http/routes";
import { type CatalogueStore } from "../shared";
import { resumeReconciliationWorkflow, startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes: HttpRoute<Context>[] = [
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
  httpRoute<Context>()(retainedTextRoute, async (c) => {
    const { run, digest, ordinal } = c.req.valid("param");
    return c.json(
      retainedWireValue(
        retainedTextSchema,
        await inspectReconciliationText(c.env.env.CATALOGUE_DB, run, digest, ordinal),
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(retainedInputListRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedInputListSchema,
        await inspectReconciliationInputs(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").run,
          c.req.valid("query").after ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(retainedInputRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedInputSchema,
        await inspectReconciliationInput(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").run,
          c.req.valid("param").ordinal,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(retainedPartitionRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedPartitionSchema,
        await inspectReconciliationPartition(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").run,
          c.req.valid("param").ordinal,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  ...retainedReconciliationActionRoutes.map(({ action, definition }) =>
    httpRoute<Context>()(definition, async (c) => {
      const { env, observedAt } = c.env;
      const run = c.req.valid("param").run;
      const result = await changeReconciliationProgress(env.CATALOGUE_DB, run, action, c.req.valid("json"), observedAt);
      if (action === "resume") await resumeReconciliationWorkflow(env.CATALOGUE_DB, env.RECONCILIATION_WORKFLOW, run);
      return c.json(retainedWireValue(retainedReconciliationStatusSchema, result), 200, {
        "Cache-Control": "no-store",
      });
    }),
  ),
  httpRoute<Context>()(retainedPartitionListRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedPartitionListSchema,
        await inspectReconciliationPartitions(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").run,
          c.req.valid("query").after ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(retainedReconciliationStatusRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedReconciliationStatusSchema,
        await inspectReconciliationProgress(c.env.env.CATALOGUE_DB, c.req.valid("param").run),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  ...identityRoutes,
  httpRoute<Context>()(retainedReconciliationStartRoute, async (c) => {
    const result = await startOrObserveReconciliationWorkflow(
      c.env.env.CATALOGUE_DB,
      c.env.env.RECONCILIATION_WORKFLOW,
      { ingestion_run_id: c.req.valid("param").run, ...c.req.valid("json") },
      c.env.observedAt,
    );
    return result.created && result.document.status !== "complete"
      ? c.json(retainedWireValue(pendingRetainedWorkflowSchema, result.document), 202, { "Cache-Control": "no-store" })
      : c.json(retainedWireValue(retainedWorkflowSchema, result.document), 200, { "Cache-Control": "no-store" });
  }),
];
