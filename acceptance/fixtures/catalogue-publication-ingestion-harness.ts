export { EvidenceIngestionWorkflow } from "./compatibility-evidence-workflow";
import { restoreFixturePublicationHealthStatement } from "../helpers/query-helpers/runtime-fixtures";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import ingestionWorker, {
  EvidenceHostWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "../../apps/ingestion/src/index";
import type {
  CatalogueBackupWorkflowParams,
} from "../../src/catalogue/backup-recovery";

export {
  EvidenceHostWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
};

export class CatalogueBackupWorkflow extends WorkflowEntrypoint<
  Env,
  CatalogueBackupWorkflowParams
> {
  override async run(
    event: Readonly<WorkflowEvent<CatalogueBackupWorkflowParams>>,
    _step: WorkflowStep,
  ): Promise<{ result_json: string }> {
    return {
      result_json: JSON.stringify({
        contract: "card-keepr-catalogue-publication-backup-harness@1",
        idempotency_key: event.payload.idempotency_key,
        ok: true,
      }),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await ingestionWorker.fetch(request, env);
    if (
      request.method === "POST" &&
      /^\/v1\/ingestion-runs\/[^/]+\/approval$/u.test(
        new URL(request.url).pathname,
      ) &&
      response.status === 200
    ) {
      await restoreFixturePublicationHealthStatement(env.CATALOGUE_DB).run();
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
