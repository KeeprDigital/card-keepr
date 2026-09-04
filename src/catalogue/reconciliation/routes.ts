import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { showReconciledPrinting } from "./card-printing-reconciliation";
import { startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes = [
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
