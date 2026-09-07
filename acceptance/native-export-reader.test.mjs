import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("native export reader paces requests, reuses a verified package and reloads after restore", async (t) => {
  const raw = Buffer.from('{"type":"card","id":"card"}\n');
  const compressed = gzipSync(raw);
  let requests = 0,
    reject = false;
  const server = createServer((request, response) => {
    requests++;
    if (reject) {
      response.writeHead(429, { "retry-after": "60" }).end("rate_limited");
      return;
    }
    if (request.url.endsWith("/component")) {
      response.end(compressed);
      return;
    }
    const base = `http://127.0.0.1:${server.address().port}`;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: {
          export_schema_major: 5,
          components: [
            {
              name: "riftbound.0",
              kind: "cards",
              records: 1,
              compressed_bytes: compressed.length,
              compressed_sha256: digest(compressed),
              uncompressed_bytes: raw.length,
              content_sha256: digest(raw),
            },
          ],
          page: { next_cursor: null },
        },
        links: { components: { "riftbound.0": `${base}/component` } },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dispatched = [];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (...args) => {
    dispatched.push(Date.now());
    return originalFetch(...args);
  });
  const reader = nativeExportReader(40);
  assert.deepEqual(await reader.records(base, "key", "revision", "cards"), [{ type: "card", id: "card" }]);
  assert.deepEqual(await reader.records(base, "key", "revision", "errata"), []);
  assert.equal(requests, 2);
  reader.clear();
  assert.equal((await reader.records(base, "key", "revision", "cards")).length, 1);
  assert.equal(requests, 4);
  reject = true;
  await assert.rejects(reader.records(base, "key", "next-revision", "cards"), (error) => error.actual === 429);
  reject = false;
  assert.equal((await reader.records(base, "key", "next-revision", "cards")).length, 1);
  assert.equal(requests, 7);
  assert.ok(dispatched.slice(1).every((at, i) => at - dispatched[i] >= 35));
});
