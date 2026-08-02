import assert from "node:assert/strict";
import test from "node:test";
import {
  deterministicGzip,
  deterministicGzipStream,
} from "../src/catalogue/export-compression.ts";
import {
  verifyComponentExportRecord,
  verifyExportRecord,
} from "../src/catalogue/export-validation.ts";

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

test("component export validation rejects a valid record from the wrong component", () => {
  const supportedGame = {
    type: "supported_game",
    id: "game_one-piece",
    key: "one-piece",
    name: "One Piece Card Game",
    supported_locales: ["EN-OCEANIA"],
    game_profile: "one-piece@1",
  };
  assert.doesNotThrow(() => verifyExportRecord(supportedGame));
  assert.throws(
    () => verifyComponentExportRecord(
      "https://card-keepr.invalid/schemas/catalogue-export-record@3#/$defs/ProductRecord",
      supportedGame,
    ),
    /component record failed schema verification/u,
  );
});
