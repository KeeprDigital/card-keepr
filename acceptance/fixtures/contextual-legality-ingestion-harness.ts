import ingestionWorker, {
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "../../apps/ingestion/src/index";
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const copy = request.clone();
    const url = new URL(request.url);
    const productionResponse = await ingestionWorker.fetch(request, env);
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
      env.CATALOGUE_DB,
      body,
      "synthetic_fixture",
    );
    return Response.json(document, { status: 201 });
  },
};
