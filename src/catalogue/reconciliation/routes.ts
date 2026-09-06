import {
  changeReconciliationProgress,
  inspectReconciliationPartitions,
  inspectReconciliationPartition,
  inspectReconciliationProgress,
} from "./reconciliation-progress";
import { inspectCanonicalIdentity, inspectIdentityReviews, resolveIdentityReview } from "./canonical-identity";
import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { showReconciledPrinting } from "./card-printing-reconciliation";
import { resumeReconciliationWorkflow, startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes = [
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/partitions/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationPartition(env.CATALOGUE_DB, params.run!, params.ordinal!)),
  ),
  ...(["pause", "resume", "abandon"] as const).map((action) =>
    route<Context>("POST", `/v1/ingestion-runs/:run/reconciliation/${action}`, async ({ env, request }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["generation", "idempotency_key"]);
      const result = await changeReconciliationProgress(env.CATALOGUE_DB, params.run!, action, {
        generation: Number(body.generation),
        idempotency_key: requiredString(body, "idempotency_key"),
      });
      if (action === "resume")
        await resumeReconciliationWorkflow(env.CATALOGUE_DB, env.RECONCILIATION_WORKFLOW, params.run!);
      return Response.json(result);
    }),
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
  route<Context>("GET", "/v1/reconciliation/identity-reviews", async ({ request, env }) => {
    const query = new URL(request.url).searchParams;
    return Response.json(
      await inspectIdentityReviews(env.CATALOGUE_DB, query.get("run_id") ?? "", query.get("after") ?? ""),
    );
  }),
  route<Context>(
    "POST",
    "/v1/reconciliation/identity-reviews/:review/resolve",
    async ({ request, env, observedAt }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["printing_id", "rationale", "idempotency_key"]);
      return Response.json(
        await resolveIdentityReview(
          env.CATALOGUE_DB,
          params.review!,
          {
            printing_id: requiredString(body, "printing_id"),
            rationale: requiredString(body, "rationale"),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        ),
      );
    },
  ),
  route<Context>("GET", "/v1/reconciliation/identities/:identity", async ({ env, request }, params) => {
    return Response.json(
      await inspectCanonicalIdentity(
        env.CATALOGUE_DB,
        params.identity!,
        new URL(request.url).searchParams.get("after") ?? "",
      ),
    );
  }),
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
  route<Context>("GET", "/v1/reconciliation/printings/:printing", async ({ env }, params) => {
    return Response.json(await showReconciledPrinting(env.CATALOGUE_DB, params.printing!));
  }),
];
