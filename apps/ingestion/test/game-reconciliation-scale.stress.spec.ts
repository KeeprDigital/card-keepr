import { expect, test } from "vitest";
import worker from "../src/index";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("a 1001-Product native candidate stays within the D1/R2 callback budget", async () => {
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
  let calls = 0;
  let methods: Record<string, number> = {};
  let metadata: Record<string, { observations: number; total: number }> = {};
  const charge = (method: string) => {
    calls++;
    methods[method] = (methods[method] ?? 0) + 1;
  };
  const observe = async (operation: unknown): Promise<unknown> => {
    const result = await operation;
    for (const value of Array.isArray(result) ? result : [result]) {
      if (!value || typeof value !== "object" || !("meta" in value)) continue;
      for (const field of ["rows_read", "rows_written", "changes", "duration"]) {
        const amount = (value.meta as Record<string, unknown>)[field];
        if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
        metadata[field] ??= { observations: 0, total: 0 };
        metadata[field].observations++;
        metadata[field].total += amount;
      }
    }
    return result;
  };
  const measured: {
    name: string;
    calls: number;
    phase: string;
    started_ms: number;
    milliseconds: number;
    methods: typeof methods;
    returned_d1_metadata: typeof metadata;
  }[] = [];
  const statement = (original: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(original, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            charge(`D1.${String(property)}`);
            return observe(Reflect.apply(value, target, args));
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (property === "batch")
        return (...args: Parameters<D1Database["batch"]>) => {
          charge("D1.batch");
          return observe(target.batch(...args));
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bucket = (original: R2Bucket, binding: string) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          charge(`${binding}.${String(property)}`);
          return Reflect.apply(value, target, args);
        };
      },
    });
  const started = Date.now();
  await runReconciliationWorkflow(
    {
      ...testEnv,
      CATALOGUE_DB: database,
      EVIDENCE_OBJECTS: bucket(testEnv.EVIDENCE_OBJECTS, "EVIDENCE_OBJECTS"),
      PRINTING_IMAGES: bucket(testEnv.PRINTING_IMAGES, "PRINTING_IMAGES"),
    },
    {
      instanceId: "native-resource-root",
      payload: params!,
    } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          calls = 0;
          methods = {};
          metadata = {};
          const attemptStarted = Date.now();
          let phase = name;
          try {
            const result = await callback();
            phase = JSON.parse(result).continuation?.phase ?? name;
            return result;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          } finally {
            measured.push({
              name,
              calls,
              phase,
              started_ms: attemptStarted - started,
              milliseconds: Date.now() - attemptStarted,
              methods,
              returned_d1_metadata: metadata,
            });
          }
        }
      },
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  const elapsed = Date.now() - started;
  const phases = new Map<string, { callbacks: number; milliseconds: number; maximumCalls: number }>();
  for (const attempt of measured) {
    const phase = phases.get(attempt.phase) ?? { callbacks: 0, milliseconds: 0, maximumCalls: 0 };
    phase.callbacks++;
    phase.milliseconds += attempt.milliseconds;
    phase.maximumCalls = Math.max(phase.maximumCalls, attempt.calls);
    phases.set(attempt.phase, phase);
  }
  console.info(
    JSON.stringify({
      contract: "card-keepr-local-reconciliation-callbacks@1",
      workload: "1001 synthetic Products; actual local D1/R2 and shipped reconciliation callbacks",
      limitation:
        "Callback wall time, not CPU. Phase is returned continuation (or step name on failure), not an exact operation trace. Counts cover D1 execution methods and two R2 bindings only; the driver simulates Workflow control calls. D1 metadata is local emulator output, unavailable through first/raw and not provider billing or independent index-write accounting. No SQL, parameters or result rows are retained.",
      elapsed_ms: elapsed,
      phases: Object.fromEntries(phases),
      callbacks: measured,
    }),
  );
  expect(elapsed, JSON.stringify(Object.fromEntries(phases))).toBeLessThan(15_000);
  expect(measured.filter(({ calls }) => calls > 100)).toEqual([]);
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({ state: "sealed" });
  expect(measured.length).toBeGreaterThan(10);
}, 120_000);
