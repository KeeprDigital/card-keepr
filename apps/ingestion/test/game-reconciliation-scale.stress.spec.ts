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
  const measured: { name: string; calls: number; phase: string; milliseconds: number }[] = [];
  const statement = (original: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(original, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            calls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (property === "batch")
        return (...args: Parameters<D1Database["batch"]>) => {
          calls++;
          return target.batch(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bucket = (original: R2Bucket) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls++;
          return Reflect.apply(value, target, args);
        };
      },
    });
  const started = Date.now();
  await runReconciliationWorkflow(
    {
      ...testEnv,
      CATALOGUE_DB: database,
      EVIDENCE_OBJECTS: bucket(testEnv.EVIDENCE_OBJECTS),
      PRINTING_IMAGES: bucket(testEnv.PRINTING_IMAGES),
    },
    {
      instanceId: "native-resource-root",
      payload: params!,
    } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          calls = 0;
          const attemptStarted = Date.now();
          let phase = name;
          try {
            const result = await callback();
            phase = JSON.parse(result).continuation?.phase ?? name;
            return result;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          } finally {
            measured.push({ name, calls, phase, milliseconds: Date.now() - attemptStarted });
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
  expect(elapsed, JSON.stringify(Object.fromEntries(phases))).toBeLessThan(15_000);
  expect(measured.filter(({ calls }) => calls > 100)).toEqual([]);
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({ state: "sealed" });
  expect(measured.length).toBeGreaterThan(10);
}, 120_000);
