import { expect, test } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import worker from "../src/index";
import {
  approve,
  collect,
  get,
  installReconciliationSuite,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";
import { replaceGameHeadForFence } from "./query-helpers/game-candidates";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

test.each(["resume", "seal"])("a changed game predecessor fences native %s", async (boundary) => {
  const seed = await reconcile((await collect("/reconciliation/base", `native-${boundary}-seed`)).id);
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const predecessor = requiredString(published.document, "resulting_revision_id");
  const run = await collect("/reconciliation/base", `native-${boundary}-evidence`);
  let params: ReconciliationWorkflowParams | undefined;
  const instance = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return instance;
    },
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = async (path: string, body: object) => {
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
    return { status: response.status, document: await response.json<Record<string, unknown>>() };
  };
  const created = await request("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: predecessor,
    idempotency_key: `native-${boundary}-intent`,
  });
  expect(created.status).toBe(201);
  const id = requiredString(created.document, "id");
  const changeHead = () => replaceGameHeadForFence(testEnv.CATALOGUE_DB).bind("catrev_spine_000", "one-piece").run();
  if (boundary === "resume") {
    expect(
      (await request(`/v1/game-candidates/${id}/pause`, { generation: 0, idempotency_key: "pause-before-head-change" }))
        .status,
    ).toBe(200);
    await changeHead();
    const resumed = await request(`/v1/game-candidates/${id}/resume`, {
      generation: 1,
      idempotency_key: "resume-after-head-change",
    });
    expect(resumed.status, JSON.stringify(resumed.document)).toBe(409);
    expect(resumed.document).toMatchObject({ code: "game_revision_mismatch" });
    expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
      state: "paused",
      generation: 1,
      deadline: created.document.deadline,
    });
    return;
  }
  let interrupted = false;
  const sqlByStatement = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlByStatement.set(proxy, sql);
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (
            !interrupted &&
            statements.some((statement) =>
              sqlByStatement.get(statement)?.includes("UPDATE game_candidates SET state = ?"),
            )
          ) {
            interrupted = true;
            await changeHead();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as WorkflowStep;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { instanceId: `native-fence-${boundary}`, payload: params! } as WorkflowEvent<ReconciliationWorkflowParams>,
    step,
  );
  expect(interrupted).toBe(true);
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
    state: "failed",
    failure_code: "game_revision_mismatch",
    expected_game_revision_id: predecessor,
    deadline: created.document.deadline,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});
