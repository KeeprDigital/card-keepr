import { expect, test } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { boundedReconciliationResources } from "../src/reconciliation-resource-budget";
import { collect, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { catalogueStore } from "../../../src/catalogue/shared";
import { initializeReconciliationProgress } from "../../../src/catalogue/reconciliation/reconciliation-progress";
import { ReconciliationReducerIndex } from "../../../src/catalogue/reconciliation/reconciliation-reducer-state";

installReconciliationSuite();

function directStep() {
  return { do: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)() } as unknown as WorkflowStep;
}

test("uncheckpointed reducer output replays within one callback and rejects changed effects", async () => {
  const source = await collect("/reconciliation/card-without-printing", "reducer-output-replay");
  const bounded = boundedReconciliationResources(testEnv, directStep());
  const store = catalogueStore(bounded.env.CATALOGUE_DB);
  await initializeReconciliationProgress(store, source.id, new Date().toISOString());
  const entries = Array.from({ length: 101 }, (_, index) => ({ key: `result-${index}`, value: { id: `result-${index}`, value: index } }));
  const index = () => new ReconciliationReducerIndex<{ id: string; value: number }>(store, source.id, "uncheckpointed_output");
  await bounded.step.do("retain output before lost checkpoint", async () => index().seedMany(entries));
  const replay = index();
  await bounded.step.do("replay output", async () => replay.seedMany(entries));
  const actual = [];
  for await (const value of replay.entityValues()) actual.push(value);
  expect(actual).toEqual(entries.map(({ value }) => value).sort((left, right) => left.id.localeCompare(right.id)));
  const changed = entries.map((entry, ordinal) => ordinal === 50 ? { ...entry, value: { ...entry.value, value: -1 } } : entry);
  await expect(bounded.step.do("reject changed output replay", async () => index().seedMany(changed))).rejects.toThrow("immutable observation effect");
});

test("a reconciliation callback cannot make its 101st D1 call", async () => {
  let calls = 0;
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(target, property) {
              if (property === "first")
                return async () => {
                  calls++;
                  return target.first();
                };
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { env, step } = boundedReconciliationResources({ ...testEnv, CATALOGUE_DB: database }, directStep());
  await expect(
    step.do("too many calls", async () => {
      for (let index = 0; index < 101; index++) await env.CATALOGUE_DB.prepare("SELECT 1").first();
    }),
  ).rejects.toThrow("100 calls");
  expect(calls).toBe(100);
});

test.each(["EVIDENCE_OBJECTS", "PRINTING_IMAGES", "CATALOGUE_EXPORTS"] as const)(
  "%s allows four open bodies and releases them when the callback closes",
  async (binding) => {
    await testEnv[binding].put("resource-budget-body", "retained evidence");
    let gets = 0;
    const bucket = new Proxy(testEnv[binding], {
      get(target, property) {
        if (property === "get")
          return (...args: Parameters<R2Bucket["get"]>) => {
            gets++;
            return target.get(...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { env, step } = boundedReconciliationResources({ ...testEnv, [binding]: bucket }, directStep());
    await expect(
      step.do("open bodies", async () => {
        for (let index = 0; index < 5; index++) await env[binding].get("resource-budget-body");
      }),
    ).rejects.toThrow("four open");
    expect(gets).toBe(4);
    await step.do("consumed bodies", async () => {
      for (let index = 0; index < 5; index++) {
        const body = await env[binding].get("resource-budget-body");
        expect(await body!.text()).toBe("retained evidence");
      }
    });
    expect(gets).toBe(9);
  },
);

test("Workflow binding and instance calls share the callback allowance", async () => {
  let gets = 0,
    statuses = 0;
  const workflow = {
    get: async () => {
      gets++;
      return {
        status: async () => {
          statuses++;
          return { status: "complete" };
        },
      };
    },
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const { env, step } = boundedReconciliationResources({ ...testEnv, RECONCILIATION_WORKFLOW: workflow }, directStep());
  await expect(
    step.do("control plane calls", async () => {
      for (let index = 0; index < 51; index++)
        await (await env.RECONCILIATION_WORKFLOW.get("retained-workflow")).status();
    }),
  ).rejects.toThrow("100 calls");
  expect({ gets, statuses }).toEqual({ gets: 50, statuses: 50 });
});
