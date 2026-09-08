import assert from "node:assert/strict";
import { createServer } from "./helpers/cli-http.mjs";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

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
