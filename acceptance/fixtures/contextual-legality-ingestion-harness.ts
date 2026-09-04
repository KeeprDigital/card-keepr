import { restoreFixturePublicationHealthStatement } from "../helpers/query-helpers/runtime-fixtures";
import { catalogueStore } from "../../src/catalogue/shared";
import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "../../apps/ingestion/src/index";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type {
  CatalogueBackupWorkflowParams,
} from "../../src/catalogue/backup-recovery";
import {
  startEvidenceRun,
  type StartEvidenceRunRequest,
} from "../../src/catalogue/source-evidence";

export {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
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
        contract: "card-keepr-contextual-legality-backup-harness@1",
        idempotency_key: event.payload.idempotency_key,
        ok: true,
      }),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const copy = request.clone();
    const url = new URL(request.url);
    const productionResponse = await ingestionWorker.fetch(request, env);
    if (
      request.method === "POST" &&
      /^\/v1\/ingestion-runs\/[^/]+\/approval$/u.test(url.pathname) &&
      productionResponse.status === 200
    ) {
      await restoreFixturePublicationHealthStatement(env.CATALOGUE_DB).run();
      return productionResponse;
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/v1/ingestion-runs/evidence" ||
      productionResponse.status !== 422
    ) {
      return productionResponse;
    }
    const problem = await productionResponse.clone().json() as {
      code?: unknown;
    };
    if (problem.code !== "adapter_origin_not_permitted") {
      return productionResponse;
    }
    const body = await copy.json() as StartEvidenceRunRequest;
    if (!body.adapter_version.startsWith("fixture-")) {
      return productionResponse;
    }
    const document = await startEvidenceRun(
      catalogueStore(env.CATALOGUE_DB),
      body,
      "synthetic_fixture",
    );
    return Response.json(document, { status: 201 });
  },
};
