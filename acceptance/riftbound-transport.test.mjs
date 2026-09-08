import assert from "node:assert/strict";
import test from "node:test";
import { riftboundReplayTransport } from "./helpers/riftbound-replay-transport.mjs";

test("Riftbound replay forwards management, signed SQL download and upload requests intact", async () => {
  const received = [];
  const transport = riftboundReplayTransport(
    {
      outboundService: async (request) => {
        received.push(request);
        return new Response("checkpoint");
      },
    },
    new Map(),
    [],
  );
  for (const [hostname, method] of [
    ["api.cloudflare.com", "POST"],
    ["native-export.invalid", "GET"],
    ["native-upload.invalid", "PUT"],
  ]) {
    const request = new Request(`https://${hostname}/snapshot`, { method });
    assert.equal(await (await transport(request)).text(), "checkpoint");
    assert.equal(received.at(-1), request);
  }
  await assert.rejects(transport(new Request("https://unexpected.invalid/snapshot")), /undeclared request/);
  assert.equal(received.length, 3);
  assert.equal((await transport(new Request("https://cmsassets.rgpub.io/unretained.png"))).status, 404);
});
