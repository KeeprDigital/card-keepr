import { expect, test } from "vitest";
import worker from "../src/index";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test.each([
  "capacity-card-identity-fanout",
  "capacity-card-facts-fanout",
  "known-card-facts-fanout",
  "capacity-nested-card-matches",
])("%s respects the D1/R2 callback budget", async (scenario) => {
  const source = await collect(`/reconciliation/${scenario}`, "native-resource-evidence");
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
        expected_game_revision_id: "catrev_spine_000",
        idempotency_key: "native-resource-candidate",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: binding },
  );
  expect(created.status).toBe(201);
  const id = requiredString(await created.json<Record<string, unknown>>(), "id");
  expect(params).toBeDefined();
  let calls = 0;
  const measured: { name: string; calls: number }[] = [];
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
      do: async (name: string, _config: unknown, callback: () => Promise<string>) => {
        calls = 0;
        try {
          return await callback();
        } finally {
          measured.push({ name, calls });
        }
      },
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect(measured.filter(({ calls }) => calls > 100)).toEqual([]);
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
    ...(scenario === "known-card-facts-fanout"
      ? { state: "sealed" }
      : { state: "failed", failure_code: "reconciliation_capacity_exceeded" }),
  });
  expect(measured.length).toBeGreaterThan(10);
});
