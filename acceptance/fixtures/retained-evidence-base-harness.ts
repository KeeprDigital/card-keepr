import { restoreFixturePublicationHealthStatement } from "../helpers/query-helpers/runtime-fixtures";
import { administrationPresentation } from "../../src/http/administration-presentation.mjs";
import {
  collectFixtureEvidence,
  injectFixtureEvidencePlan,
} from "../../test/support/fixture-evidence-plan";
import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "../../test/support/ingestion-worker";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type {
  CatalogueBackupWorkflowParams,
} from "../../src/catalogue/backup-recovery";
import type { StartEvidenceRunRequest } from "../../src/catalogue/source-evidence";

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
        contract: "card-keepr-retained-evidence-backup-harness@1",
        idempotency_key: event.payload.idempotency_key,
        ok: true,
      }),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/v1/ingestion-runs/evidence" &&
      request.headers.get("authorization") === `Bearer ${env.ADMINISTRATION_KEY}`
    ) {
      const body = await request.clone().json() as StartEvidenceRunRequest;
      if (body.adapter_version?.startsWith("fixture-")) {
        const document = await injectFixtureEvidencePlan(env.CATALOGUE_DB, body);
        const collected = await collectFixtureEvidence(
          env.CATALOGUE_DB,
          env.EVIDENCE_OBJECTS,
          env.OFFICIAL_SOURCE_TRANSPORT,
          String(document.id),
        );
        return Response.json(
          request.headers.get("accept") === "application/vnd.card-keepr.cli+json"
            ? administrationPresentation(collected, 201)
            : collected,
          { status: 201, headers: { vary: "Accept" } },
        );
      }
    }
    const productionResponse = await ingestionWorker.fetch(request, env);
    if (
      request.method === "POST" &&
      /^\/v1\/ingestion-runs\/[^/]+\/approval$/u.test(url.pathname) &&
      productionResponse.status === 200
    ) {
      await restoreFixturePublicationHealthStatement(env.CATALOGUE_DB).run();
      return productionResponse;
    }
    return productionResponse;
  },
};
