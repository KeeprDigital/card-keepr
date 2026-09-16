import assert from "node:assert/strict";
import { createServer } from "./helpers/cli-http.mjs";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("authenticated CLI requests refuse redirects before another endpoint receives the key", async (t) => {
  let forwarded = 0;
  const destination = createServer((_request, response) => {
    forwarded++;
    response.end("{}");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => destination.close(resolve)));
  const source = createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/v1/status` });
    response.end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => source.close(resolve)));
  const result = await runCli(["status", "--json"], {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${source.address().port}`,
    KEEPR_ADMINISTRATION_KEY: "transport-test-administration-key",
  });
  assert.equal(forwarded, 0);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.includes("transport-test-administration-key"), false);
});

test("the shared client refuses non-local plaintext credentials before transport", async () => {
  const { request } = await import("../cli/lib/http-client.mjs");
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    return new Response("{}");
  };
  assert.throws(
    () => request("http://production.invalid/v1/status", { headers: { authorization: "Bearer private" } }, fetchImpl),
    /credential_transport_requires_https/,
  );
  assert.throws(
    () => request("https://owner:private@production.invalid/v1/status", {}, fetchImpl),
    /credential_url_forbidden/,
  );
  assert.equal(calls, 0);
  await request("http://127.0.0.1:8788/v1/status", { headers: { authorization: "Bearer development" } }, fetchImpl);
  await request("https://production.invalid/v1/status", { headers: { authorization: "Bearer private" } }, fetchImpl);
  assert.equal(calls, 2);
});

test("candidate list omits an absent cursor and preserves a supplied opaque cursor", async (t) => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ candidates: [], next_cursor: null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
    KEEPR_ADMINISTRATION_KEY: "cursor-test-key",
  };
  for (const cursor of [[], ["--after", "candidate:next_123"]]) {
    const result = await runCli(["game-candidate", "list", "--run-id", "run_123", ...cursor, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  assert.deepEqual(paths, [
    "/v1/ingestion-runs/run_123/game-candidates",
    "/v1/ingestion-runs/run_123/game-candidates?after=candidate%3Anext_123",
  ]);
});

test("source budget and linked retry commands preserve explicit limits and legacy initialization intent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-budget-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const budget = { max_dispatches: 2, max_source_bytes: 1024, dispatch_deadline: "2099-01-01T00:00:00.000Z" };
  const previousPath = join(directory, "previous.json");
  const budgetPath = join(directory, "budget.json");
  await writeFile(budgetPath, JSON.stringify(budget));
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ path: request.url, method: request.method, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const environment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
    KEEPR_ADMINISTRATION_KEY: "acquisition-cli-key",
  };
  for (const [generation, previous] of [
    [0, null],
    [1, { ...budget, max_dispatches: 1 }],
  ]) {
    await writeFile(previousPath, JSON.stringify(previous));
    const result = await runCli(
      [
        "source",
        "budget",
        "extend",
        "--run-id",
        "run_123",
        "--expected-generation",
        String(generation),
        "--expected-budget-file",
        previousPath,
        "--budget-file",
        budgetPath,
        "--idempotency-key",
        `budget_${generation}`,
        "--json",
      ],
      environment,
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(requests.at(-1), {
      path: "/v1/ingestion-runs/run_123/acquisition-budget/extension",
      method: "POST",
      body: {
        expected_generation: generation,
        expected_budget: previous,
        acquisition_budget: budget,
        idempotency_key: `budget_${generation}`,
      },
    });
  }
  const retry = ["source", "retry", "--run-id", "run_123", "--idempotency-key", "retry_001", "--json"];
  const missing = await runCli(retry, environment);
  assert.notEqual(missing.code, 0);
  assert.equal(requests.length, 2);
  const supplied = await runCli([...retry, "--budget-file", budgetPath], environment);
  assert.equal(supplied.code, 0, supplied.stdout + supplied.stderr);
  assert.deepEqual(requests.at(-1), {
    path: "/v1/ingestion-runs/run_123/collection/retry",
    method: "POST",
    body: { idempotency_key: "retry_001", acquisition_budget: budget },
  });
});
