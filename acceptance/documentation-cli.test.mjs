import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

test("CLI downloads public and owner documentation with the selected mount and credential", async (t) => {
  const requests = [];
  const html = '<!doctype html><html lang="en"><title>API reference</title><body>Complete reference</body></html>';
  const specification = { openapi: "3.1.0", info: { title: "Reference", version: "1" }, paths: {} };
  const server = createServer((request, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    response.setHeader(
      "content-type",
      request.url.endsWith("openapi.json") ? "application/json" : "text/html; charset=utf-8",
    );
    response.end(request.url.endsWith("openapi.json") ? JSON.stringify(specification) : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    KEEPR_API_URL: `${base}/api/`,
    KEEPR_INGESTION_URL: `${base}/ingest/`,
    KEEPR_API_KEY: "consumer-test",
    KEEPR_ADMINISTRATION_KEY: "owner-test",
  };
  for (const kind of ["catalogue", "administration"]) {
    const page = await runCli(["docs", kind], environment);
    assert.equal(page.code, 0, page.stderr || page.stdout);
    assert.equal(page.stdout.trim(), html);
    const spec = await runCli(["docs", kind, "--json"], environment);
    assert.equal(spec.code, 0, spec.stderr || spec.stdout);
    assert.deepEqual(JSON.parse(spec.stdout), specification);
  }
  assert.deepEqual(requests, [
    { path: "/api/docs", authorization: undefined },
    { path: "/api/openapi.json", authorization: undefined },
    { path: "/ingest/docs", authorization: "Bearer owner-test" },
    { path: "/ingest/openapi.json", authorization: "Bearer owner-test" },
  ]);
});
