import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicGzip,
  deterministicGzipStream,
} from "../src/catalogue/export-compression.ts";

const goldenInput = new TextEncoder().encode('{"id":"golden"}\n');
const goldenHex =
  "1f8b08000000000002ffab56ca4c51b2524acfcf4949cd53aae50200cc28fff510000000";

test("buffered and streaming export compression share exact golden bytes", async () => {
  const chunks = [goldenInput.slice(0, 3), goldenInput.slice(3, 11), goldenInput.slice(11)];
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  const streamed = new Uint8Array(
    await new Response(deterministicGzipStream(stream)).arrayBuffer(),
  );
  assert.equal(Buffer.from(deterministicGzip(goldenInput)).toString("hex"), goldenHex);
  assert.equal(Buffer.from(streamed).toString("hex"), goldenHex);
});
