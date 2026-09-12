import { reconciliationBindingObserver, type BindingObservation } from "./reconciliation-binding-observer";
import { expect, test } from "vitest";
import worker from "../src/index";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("a 1001-Product native candidate stays within the D1/R2 callback budget", async ({ task }) => {
  const fixture = "scale-1001-products";
  const predecessor = "catrev_spine_000";
  const source = await collect(`/reconciliation/${fixture}`, "native-resource-evidence");
  let params: ReconciliationWorkflowParams | undefined;
  const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return queued;
    },
    get: async () => queued,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const created = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/game-candidates", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: source.id,
        supported_game: "one-piece",
        expected_game_revision_id: predecessor,
        idempotency_key: "native-resource-candidate",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: binding },
  );
  expect(created.status).toBe(201);
  const id = requiredString(await created.json<Record<string, unknown>>(), "id");
  expect(params).toBeDefined();
  const observer = reconciliationBindingObserver();
  const measured: (BindingObservation & {
    name: string;
    phase: string;
    started_ms: number;
    milliseconds: number;
    succeeded: boolean;
  })[] = [];
  const started = Date.now();
  let elapsed: number;
  const phases = new Map<string, { callbacks: number; milliseconds: number; maximumCalls: number }>();
  try {
    await runReconciliationWorkflow(
      {
        ...testEnv,
        CATALOGUE_DB: observer.database(testEnv.CATALOGUE_DB),
        EVIDENCE_OBJECTS: observer.bucket(testEnv.EVIDENCE_OBJECTS, "EVIDENCE_OBJECTS"),
        PRINTING_IMAGES: observer.bucket(testEnv.PRINTING_IMAGES, "PRINTING_IMAGES"),
      },
      {
        instanceId: "native-resource-root",
        payload: params!,
      } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>,
      {
        do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
          for (let attempt = 0; ; attempt++) {
            const observation = observer.begin();
            let succeeded = false;
            const attemptStarted = Date.now();
            let phase = name;
            try {
              const result = await callback();
              phase = JSON.parse(result).continuation?.phase ?? name;
              succeeded = true;
              return result;
            } catch (error) {
              if (attempt >= config.retries.limit) throw error;
            } finally {
              measured.push({
                name,
                ...observation,
                succeeded,
                phase,
                started_ms: attemptStarted - started,
                milliseconds: Date.now() - attemptStarted,
              });
              observer.end();
            }
          }
        },
      } as unknown as import("cloudflare:workers").WorkflowStep,
      { callbacks: new Map(), created: [], observeMethod: observer.driverMethod, observeEvent: observer.driverEvent },
    );
  } finally {
    elapsed = Date.now() - started;
    for (const attempt of measured) {
      const phase = phases.get(attempt.phase) ?? { callbacks: 0, milliseconds: 0, maximumCalls: 0 };
      phase.callbacks++;
      phase.milliseconds += attempt.milliseconds;
      phase.maximumCalls = Math.max(phase.maximumCalls, attempt.calls);
      phases.set(attempt.phase, phase);
    }
    const report = {
      contract: "card-keepr-local-reconciliation-callbacks@2",
      workload: "1001 synthetic Products; actual local D1/R2 and shipped reconciliation callbacks",
      limitation:
        "Callback wall time, not CPU. Phase is returned continuation (or step name on failure), not an exact operation trace. Counts are method entries, including D1 exec/session execution, two R2 bindings and nested multipart methods, plus simulated driver create/get/status/sendEvent. Batch statement totals are submitted, not executed counts. R2 size is returned object metadata, not consumed/transferred bytes. Workflow wait events and outside-callback calls are separate. D1 optional metadata is recorded only when returned; first/raw have no execution metadata. No provider billing, CPU, independent index-write accounting, SQL, keys, parameters, bodies or row values are retained. Deprecated D1 dump and unused Workflow administration/createBatch methods are excluded.",
      elapsed_ms: elapsed,
      timing_policy: "diagnostic; no hardware-independent elapsed-time requirement",
      environment: "Cloudflare emulator; see runner OS and pinned Node/toolchain in the run log",
      phases: Object.fromEntries(phases),
      callbacks: measured,
      outside_callbacks: observer.outsideCallbacks,
    };
    Object.assign(task.meta, { reconciliationBindingReport: report });
    console.info(JSON.stringify(report));
  }
  // Elapsed time is diagnostic. Report resource and completion failures independently. The observer
  // must see real work, but the number of callback subdivisions is not a contract.
  expect.soft(measured.some(({ calls, succeeded }) => calls > 0 && succeeded)).toBe(true);
  expect
    .soft(
      measured.filter(({ calls }) => calls > 100),
      "callbacks exceeding the resource budget",
    )
    .toEqual([]);
  expect.soft((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({ state: "sealed" });
}, 120_000);
