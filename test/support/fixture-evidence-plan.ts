import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { catalogueStore } from "../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  collectSourceRequestBatch,
  finalizeEvidenceRun,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  type StartEvidenceRunRequest,
  showEvidenceRun,
  startEvidenceRun,
} from "../../src/catalogue/source-evidence";
import { validateEvidencePlans } from "../../src/catalogue/source-evidence/source-evidence-model";

/** Fixture documents enter the ordinary graph as one discovery root per
 * lineage, followed by retained listing children. No graph guard is bypassed. */
export async function injectFixtureEvidencePlan(
  database: D1Database,
  request: StartEvidenceRunRequest,
): Promise<Record<string, unknown>> {
  const store = catalogueStore(database);
  await validateEvidencePlans(request);
  const inputs = "plans" in request ? request.plans : [request];
  const plans = inputs.map((plan) => {
    const adapter = requiredSourceAdapter(plan.adapter_version);
    const root = adapter.requiredSurfaces?.[0] ?? "discovery";
    return {
      ...plan,
      requests: plan.requests.length === 0 ? [] : [{ ...plan.requests[0]!, id: `${plan.source_lineage}:${root}` }],
    };
  });
  const result = await startEvidenceRun(store, { ...request, plans });
  const runId = String(result.id);
  const run = await requiredEvidenceRun(store, runId);
  const roots = await pendingEvidenceRequests(store, runId);
  for (const [index, input] of inputs.entries()) {
    if (input.requests.length <= 1) continue;
    const parent = roots.find((row) => row.request_id === plans[index]!.requests[0]!.id);
    if (parent === undefined) continue;
    await appendDiscoveredEvidenceRequests(
      store,
      run,
      parent,
      input.requests.slice(1).map((item) => ({ role: "listing", url: item.url, headers: item.headers ?? {} })),
    );
  }
  return showEvidenceRun(store, runId);
}

/** Exercise real capture/parsing commands while leaving reconciliation to the
 * test that inspects or deliberately alters the retained evidence. */
export async function collectFixtureEvidence(
  database: D1Database,
  evidenceObjects: R2Bucket,
  officialSourceTransport: Fetcher,
  runId: string,
): Promise<Record<string, unknown>> {
  const store = catalogueStore(database);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const run = await requiredEvidenceRun(store, runId);
    if (run.state !== "collecting") return showEvidenceRun(store, runId);
    const requests = await pendingEvidenceRequests(store, runId);
    if (requests.length > 0) {
      const hostname = new URL(requests[0]!.url).hostname;
      const result = await collectSourceRequestBatch({
        database: store,
        evidenceObjects,
        officialSourceTransport,
        runId,
        hostname,
        pacingMode: "immediate",
        pacingIntervalMilliseconds: 0,
        requests: requests.filter((request) => new URL(request.url).hostname === hostname).slice(0, 8),
      });
      if (result.halt?.kind === "retry_wait") {
        const waitMs = result.halt.wait_ms;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    await finalizeEvidenceRun(store, runId);
  }
  throw new Error(`Fixture collection ${runId} did not finish within its bounded capture window.`);
}
