import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runCli } from "./helpers/acceptance-runtime.mjs";

test("publication CLI sends an integer and presents ordinary receipt/status documents locally", async (t) => {
  const calls = [];
  let state = "waiting_artifacts";
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => response.destroy(error));
  });
  async function handle(request, response) {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      path: request.url,
      accept: request.headers.accept,
      body: body ? JSON.parse(body) : null,
    });
    response.setHeader("content-type", "application/json");
    const receipt = request.method === "POST";
    response.statusCode = receipt ? 202 : 200;
    response.end(
      JSON.stringify({
        contract: receipt ? "card-keepr-publication-acceptance@1" : "card-keepr-game-publication@1",
        id: "publication_cli",
        state: receipt ? "approved" : state,
        links: { status: "http://127.0.0.1/v1/publications/publication_cli" },
      }),
    );
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const environment = {
    KEEPR_ADMINISTRATION_KEY: "synthetic-key",
    KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const accepted = await runCli(
    [
      "publication",
      "approve",
      "--candidate-id",
      "candidate_cli",
      "--manifest-digest",
      "a".repeat(64),
      "--expected-game-revision-id",
      "catrev_cli",
      "--generation",
      "0",
      "--idempotency-key",
      "approve-cli",
      "--json",
    ],
    environment,
  );
  assert.equal(accepted.code, 10, accepted.stderr || accepted.stdout);
  assert.equal(JSON.parse(accepted.stdout).contract, "card-keepr-publication-acceptance@1");
  assert.equal(calls[0].body.generation, 0);
  assert.equal(calls[0].accept, "application/json");
  for (const [next, exit] of [
    ["waiting_artifacts", 10],
    ["retry_paused", 10],
    ["failed", 8],
    ["published", 0],
  ]) {
    state = next;
    const status = await runCli(["publication", "status", "--operation-id", "publication_cli"], environment);
    assert.equal(status.code, exit, status.stderr || status.stdout);
    assert.match(status.stdout, new RegExp(next));
  }
});
