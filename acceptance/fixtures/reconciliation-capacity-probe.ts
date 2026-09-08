import worker from "../../test/support/ingestion-worker";
export * from "../../test/support/ingestion-worker";
import { syntheticSourceAdapterMigration } from "../../test/support/source-adapters/migration";
import { injectFixtureEvidencePlan, collectFixtureEvidence } from "../../test/support/fixture-evidence-plan";
import { reconciliationSourceDocument } from "../../test/support/fake-publisher/reconciliation-documents";
import { runReconciliationWorkflow } from "../../apps/ingestion/test/reconciliation-workflow-driver";
import type { ReconciliationWorkflowParams } from "../../src/catalogue/reconciliation";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

// Explicit synthetic setup and direct Workflow control driver around shipped
// collection/reconciliation code. No Vitest runner lives in this isolate.
export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname === "/setup") {
      await env.CATALOGUE_DB.batch(syntheticSourceAdapterMigration.queries.map((sql) => env.CATALOGUE_DB.prepare(sql)));
      const source = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
        supported_game: "one-piece", source_lineage: "one-piece-en", adapter_version: "fixture-one-piece-json@3",
        idempotency_key: "capacity-memory-source",
        requests: [{id: "cards", method: "GET", url: "https://official-source.invalid/reconciliation/scale-1001-products"}],
      });
      const { source_url: sourceUrl } = await request.json<{source_url?: string}>();
      const transport = {fetch: async (url: string) => sourceUrl
        ? fetch(sourceUrl)
        : Response.json(reconciliationSourceDocument("scale-1001-products", "", String(url)))} as unknown as Fetcher;
      await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, transport, String(source.id));
      let params: ReconciliationWorkflowParams | undefined;
      const queued = {status: async () => ({status: "queued"})} as unknown as WorkflowInstance;
      const binding = {create: async (options: {params: ReconciliationWorkflowParams}) => {params = options.params; return queued;}, get: async () => queued} as unknown as Env["RECONCILIATION_WORKFLOW"];
      const response = await worker.fetch(new Request("https://owner.invalid/v1/game-candidates", {
        method: "POST", headers: {authorization: "Bearer probe-owner", "content-type": "application/json"},
        body: JSON.stringify({ingestion_run_id: source.id, supported_game: "one-piece", expected_game_revision_id: "catrev_spine_000", idempotency_key: "capacity-memory-candidate"}),
      }), {...env, RECONCILIATION_WORKFLOW: binding});
      if (response.status !== 201 || !params) return response;
      return Response.json({candidate: await response.json(), params});
    }
    const {params, id} = await request.json<{params: ReconciliationWorkflowParams; id: string}>();
    const phases: {phase: string; started_ms: number; duration_ms: number}[] = [];
    const started = Date.now();
    await runReconciliationWorkflow(env, {instanceId: "capacity-memory-root", payload: params} as WorkflowEvent<ReconciliationWorkflowParams>, {
      do: async (name: string, config: {retries: {limit: number}}, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          const start = Date.now();
          let phase = name;
          let status = 200;
          try {
            const result = await callback();
            phase = JSON.parse(result).continuation?.phase ?? name;
            return result;
          } catch (error) {
            status = 500;
            if (attempt >= config.retries.limit) throw error;
          } finally {
            const duration = Date.now() - start;
            phases.push({phase, started_ms: start - started, duration_ms: duration});
            console.info(JSON.stringify({contract: "card-keepr-operational-log@1", event: "workflow.step.completed", runtime: "probe-driver", request: {method: "WORKFLOW", route: "/probe/reconciliation"}, workflow: {step: phase}, duration_ms: duration, status, d1: {}}));
          }
        }
      },
    } as unknown as WorkflowStep);
    const elapsed = Date.now() - started;
    const status = await worker.fetch(new Request(`https://owner.invalid/v1/game-candidates/${id}`, {headers: {authorization: "Bearer probe-owner"}}), env);
    return Response.json({elapsed_ms: elapsed, candidate: await status.json(), phases});
  },
};
