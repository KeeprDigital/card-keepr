import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";

// Synthetic publisher responses exercise the shipped native collection/preparation Workflows.
// The legacy publication acceptance harness is deliberately absent.
test("one owner CLI start verifies native artifacts without exposing any unfinished catalogue data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-native-preparation-"));
  const statePath = join(directory, "shared-state"),
    adminKey = randomUUID(),
    apiKey = randomUUID();
  const config = JSON.parse(await readFile(resolve("apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [{ binding: "OFFICIAL_SOURCE_TRANSPORT", service: "card-keepr-synthetic-official-source" }];
  const configPath = join(directory, "ingestion.json"),
    adminEnv = join(directory, "admin.env"),
    apiEnv = join(directory, "api.env"),
    planPath = join(directory, "plan.json");
  await Promise.all([
    writeFile(configPath, JSON.stringify(config)),
    writeFile(adminEnv, `ADMINISTRATION_KEY=${adminKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: "digimon",
            source_lineage: "digimon-en",
            adapter_version: "digimon-en@7",
            requests: [
              {
                id: "digimon-en:discovery",
                url: "https://world.digimoncard.com/cards/index.php?search=true",
                headers: {
                  accept: "text/html; card-keepr-digimon-scenario=card-keepr-acceptance-digimon/complete",
                  "user-agent": "card-keepr-acceptance-digimon/complete",
                },
              },
            ],
          },
        ],
      }),
    ),
  ]);
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
  });
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  workers.push(source);
  const ingestion = await startWorker({ config: configPath, envFile: adminEnv, statePath, migrate: true });
  workers.push(ingestion);
  await waitForHealth(`${ingestion.url}/health`, adminKey, ingestion);
  const api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
  workers.push(api);
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: adminKey };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const get = async (path) => {
    const response = await fetch(`${ingestion.url}${path}`, { headers: { authorization: `Bearer ${adminKey}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const consumer = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const body = await response.json();
    delete body.request_id;
    return { status: response.status, body };
  };
  const before = await consumer("/v1/cards?game=digimon");
  const run = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "native-artifact-source"]);
  await cli(["source", "resume", "--run-id", run.id]);
  let candidate;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const collection = await get(`/v1/ingestion-runs/${run.id}/game-candidates`);
    if (collection.candidates.length) {
      candidate = await get(`/v1/game-candidates/${collection.candidates[0].id}`);
      if (candidate.state !== "preparing") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(candidate?.state, "sealed", JSON.stringify(candidate) + ingestion.getOutput());
  const args = [
    "publication-preparation",
    "start",
    "--candidate-id",
    candidate.id,
    "--manifest-digest",
    candidate.manifest_digest,
    "--generation",
    String(candidate.generation),
    "--sequence",
    "0",
    "--idempotency-key",
    "native-artifact-start",
  ];
  await cli(args);
  let status;
  const preparationDeadline = Date.now() + 30000;
  while (Date.now() < preparationDeadline) {
    status = await get(`/v1/game-candidates/${candidate.id}/publication-preparation`);
    if (status.state !== "preparing") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.state, "verified", JSON.stringify(status) + ingestion.getOutput());
  assert.equal(status.deadline, candidate.deadline);
  assert.equal(
    (await cli(["publication-preparation", "status", "--candidate-id", candidate.id])).root_digest,
    status.root_digest,
  );
  assert.deepEqual(await consumer("/v1/cards?game=digimon"), before);
  const partitions = await get(`/v1/game-candidates/${candidate.id}/partitions`);
  const cards = await get(
    `/v1/game-candidates/${candidate.id}/partitions/${partitions.partitions.find((part) => part.kind === "cards").ordinal}`,
  );
  assert.equal((await consumer(`/v1/cards/${cards.records[0].id}`)).status, 404);
  const images = partitions.partitions.find((part) => part.kind === "printing_images");
  if (images) {
    const page = await get(`/v1/game-candidates/${candidate.id}/partitions/${images.ordinal}`);
    assert.equal((await consumer(`/v1/printing-images/${page.records[0].id}/content`)).status, 404);
  }
  await cli(args);
  assert.equal(
    (await get(`/v1/game-candidates/${candidate.id}/publication-preparation`)).root_digest,
    status.root_digest,
  );
});
