import assert from "node:assert/strict";
import { createServer } from "./helpers/cli-http.mjs";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

test("owner CLI prepares retained game evidence with an exact predecessor", async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({ method: request.method, path: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "candidate_fixture", state: "preparing" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runCli(
    [
      "game-candidate",
      "prepare",
      "--run-id",
      "retained_run",
      "--game",
      "riftbound",
      "--expected-game-revision-id",
      "catrev_spine_000",
      "--idempotency-key",
      "reviewed_retained",
      "--yes",
      "--json",
    ],
    {
      KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
      KEEPR_ADMINISTRATION_KEY: "fixture-owner-key",
    },
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(received, [
    {
      method: "POST",
      path: "/v1/game-candidates",
      body: {
        ingestion_run_id: "retained_run",
        supported_game: "riftbound",
        expected_game_revision_id: "catrev_spine_000",
        idempotency_key: "reviewed_retained",
      },
    },
  ]);
});
