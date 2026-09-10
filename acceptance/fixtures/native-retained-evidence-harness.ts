// Only collection scheduling is controlled for synthetic source fixtures.
// Candidate preparation, publication and SQL backup use the shipped Workflows.
export * from "../../test/support/ingestion-worker";
import ingestionWorker from "../../test/support/ingestion-worker";
import { collectFixtureEvidence, injectFixtureEvidencePlan } from "../../test/support/fixture-evidence-plan";
import { administrationPresentation } from "../../src/http/administration-presentation.mjs";
import type { StartEvidenceRunRequest } from "../../src/catalogue/source-evidence";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/ingestion-runs/evidence" &&
        request.headers.get("authorization") === `Bearer ${env.ADMINISTRATION_KEY}`) {
      const body = await request.clone().json<StartEvidenceRunRequest>();
      const plans = "plans" in body ? body.plans : [body];
      if (plans.length === 1 && plans.every((plan) => plan.adapter_version.startsWith("fixture-"))) {
        const run = await injectFixtureEvidencePlan(env.CATALOGUE_DB, body);
        const collected = await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, env.OFFICIAL_SOURCE_TRANSPORT, String(run.id));
        return Response.json(request.headers.get("accept") === "application/vnd.card-keepr.cli+json"
          ? administrationPresentation(collected, 201) : collected, { status: 201, headers: { vary: "Accept" } });
      }
    }
    return ingestionWorker.fetch(request, env);
  },
};
