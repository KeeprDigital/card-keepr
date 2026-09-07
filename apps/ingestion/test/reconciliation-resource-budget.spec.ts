import { expect, test } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { boundedReconciliationResources } from "../src/reconciliation-resource-budget";
import { installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

function directStep() {
  return { do: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)() } as unknown as WorkflowStep;
}

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

test("four R2 bodies may remain open, and closing the callback releases them", async () => {
  await testEnv.EVIDENCE_OBJECTS.put("resource-budget-body", "retained evidence");
  let gets = 0;
  const bucket = new Proxy(testEnv.EVIDENCE_OBJECTS, {
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
  const { env, step } = boundedReconciliationResources({ ...testEnv, EVIDENCE_OBJECTS: bucket }, directStep());
  await expect(
    step.do("open bodies", async () => {
      for (let index = 0; index < 5; index++) await env.EVIDENCE_OBJECTS.get("resource-budget-body");
    }),
  ).rejects.toThrow("four open");
  expect(gets).toBe(4);
  await step.do("consumed bodies", async () => {
    for (let index = 0; index < 5; index++) {
      const body = await env.EVIDENCE_OBJECTS.get("resource-budget-body");
      expect(await body!.text()).toBe("retained evidence");
    }
  });
  expect(gets).toBe(9);
});

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
