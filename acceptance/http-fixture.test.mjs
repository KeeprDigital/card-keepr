import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { createFixtureServer } from "./helpers/http-fixture.mjs";

async function listen(t, handle) {
  const server = createFixtureServer(handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test(
  "a rejected HTTP fixture request returns a failure and leaves later requests usable",
  {
    timeout: 5000,
  },
  async (t) => {
    const received = [];
    const url = await listen(t, async (incoming, outgoing) => {
      let text = "";
      for await (const chunk of incoming) text += chunk;
      received.push(JSON.parse(text));
      outgoing.writeHead(204).end();
    });
    const failed = await fetch(url, { method: "POST", body: "{invalid" });
    assert.equal(failed.status, 500);
    assert.equal(await failed.text(), "HTTP fixture failed");
    const valid = await fetch(url, { method: "POST", body: '{"inputs":{}}' });
    assert.equal(valid.status, 204);
    assert.deepEqual(received, [{ inputs: {} }]);
  },
);

test("an interrupted request stream is contained by its HTTP fixture", { timeout: 5000 }, async (t) => {
  const started = Promise.withResolvers();
  const settled = Promise.withResolvers();
  const url = await listen(t, async (incoming, outgoing) => {
    if (incoming.url === "/abort") {
      started.resolve();
      try {
        for await (const _chunk of incoming) {
          /* Drain the request until its socket is interrupted. */
        }
      } finally {
        settled.resolve();
      }
    }
    outgoing.writeHead(204).end();
  });
  const client = request(`${url}/abort`, { method: "POST", headers: { "content-length": "100" } });
  client.on("error", () => {
    /* The client deliberately aborts this request. */
  });
  t.after(() => client.destroy());
  client.write("partial");
  await started.promise;
  client.destroy();
  await settled.promise;
  assert.equal((await fetch(url)).status, 204);
});
