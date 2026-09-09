import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "./helpers/cli-http.mjs";
import { runCli } from "./helpers/acceptance-runtime.mjs";

test("cleanup CLI submits typed policy and generation intents and reads durable status without a deletion loop", async (t) => {
  const calls = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    calls.push({ path: request.url, method: request.method, body: body ? JSON.parse(body) : null });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "cleanup_fixture", state: "pending", generation: 0 }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
    KEEPR_ADMINISTRATION_KEY: "local-synthetic-key",
  };
  for (const args of [
    [
      "evidence-cleanup",
      "start",
      "--run-id",
      "run_fixture",
      "--idempotency-key",
      "cleanup_fixture",
      "--retention-days",
      "45",
    ],
    ["evidence-cleanup", "status", "--cleanup-id", "cleanup_fixture"],
    ["evidence-cleanup", "retry", "--cleanup-id", "cleanup_fixture", "--expected-generation", "0"],
    ["staging-cleanup", "start", "--preparation-id", "preparation_fixture", "--idempotency-key", "staging_fixture"],
  ]) {
    const result = await runCli([...args, "--json"], env);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(calls, [
    {
      path: "/v1/ingestion-runs/run_fixture/evidence-cleanup",
      method: "POST",
      body: { idempotency_key: "cleanup_fixture", retention_days: 45 },
    },
    { path: "/v1/evidence-cleanups/cleanup_fixture", method: "GET", body: null },
    { path: "/v1/evidence-cleanups/cleanup_fixture/retry", method: "POST", body: { expected_generation: 0 } },
    {
      path: "/v1/reconciliation-operations/preparation_fixture/evidence-cleanup",
      method: "POST",
      body: { idempotency_key: "staging_fixture" },
    },
  ]);
  const invalid = await runCli(
    ["evidence-cleanup", "retry", "--cleanup-id", "cleanup_fixture", "--expected-generation", "1.5", "--json"],
    env,
  );
  assert.equal(invalid.code, 2);
  assert.equal(calls.length, 4);
});
