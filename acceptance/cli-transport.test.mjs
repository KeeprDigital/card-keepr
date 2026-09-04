import assert from "node:assert/strict";
import { createServer } from "node:http";
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
