import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport, waitForNativeCollection } from "./helpers/native-catalogue-runtime.mjs";

// Actual retained HTTP bodies. External HTTP and Cloudflare control plane are
// replayed locally; collection, parsing and all owner operations are shipped code.
test("retained P-001: owner collects every declared Bandai record through native workflows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-real-one-piece-"));
  const statePath = join(directory, "state");
  const pack = resolve("acceptance/fixtures/real-sources/2026-09-06");
  const manifest = JSON.parse(await readFile(join(pack, "manifest.json"), "utf8"));
  const captures = new Map(
    await Promise.all(
      manifest.captures.map(async (c) => [c.url, { ...c, bodyBytes: await readFile(join(pack, c.body)) }]),
    ),
  );
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const served = [];
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key },
    outboundService: async (request) => {
      if (new URL(request.url).hostname === "api.cloudflare.com") return checkpoint.outboundService(request);
      const capture = captures.get(request.url);
      assert.ok(capture, `undeclared network request ${request.url}`);
      served.push(capture.id);
      return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
    },
  });
  t.after(async () => {
    await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const planPath = join(directory, "plan.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-en@6",
          subset: "p-001-catalogue",
          requests: [
            { id: "one-piece-en:p-001-catalogue", url: "https://en.onepiece-cardgame.com/cardlist/?freewords=P-001" },
          ],
        },
        {
          supported_game: "one-piece",
          source_lineage: "limitless-one-piece-en",
          adapter_version: "limitless-one-piece-en@1",
          subset: "p-001-catalogue",
          requests: [
            { id: "limitless-one-piece-en:p-001-catalogue", url: "https://onepiece.limitlesstcg.com/cards/en/P-001" },
          ],
        },
      ],
    }),
  );
  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "real-p001", "--json"],
    environment,
  );
  assert.equal(collected.code, 0, `${collected.stdout} ${collected.stderr}`);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/evidence`,
    (d) => d.state === "parsing" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
  );
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) => d.candidates.length && d.candidates.every((c) => ["sealed", "failed"].includes(c.state)),
    environment,
    worker,
  );
  const shown = await runCli(["source", "show", "--run-id", run.id, "--json"], environment);
  assert.equal(shown.code, 0, shown.stdout);
  const evidence = JSON.parse(shown.stdout);
  const proposed = await runCli(["entity-proposal", "list", "--game", "one-piece", "--json"], environment);
  assert.equal(proposed.code, 0, proposed.stdout);
  assert.equal(JSON.parse(proposed.stdout).proposals.length, 15);
  assert.equal(evidence.evidence_plans[0].coverage.subset, "p-001-catalogue");
  assert.equal(evidence.snapshots.length, 24);
  assert.deepEqual(
    [...new Set(served)].sort(),
    [
      "bandai-p001",
      ...Array.from({ length: 7 }, (_, i) => `bandai-p001-image-${i}`),
      "limitless-p001",
      ...Array.from({ length: 7 }, (_, i) => `limitless-p001-v${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `limitless-p001-image-${i}`),
    ].sort(),
  );
});
