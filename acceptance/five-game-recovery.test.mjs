import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { build } from "esbuild";
import { reconciliationSourceDocument } from "../test/support/fake-publisher/reconciliation-documents.ts";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  nativeCheckpointTransport,
  publishNativeCollection,
  paceNativeRequest,
} from "./helpers/native-catalogue-runtime.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";

// Synthetic source facts, actual publication/backup Workflows and SQL imports.
// This bounded composition regression is separate from real Riot evidence.
test("five-game composition and current plus two survive an actual SQL import", async (t) => {
  const exportReader = nativeExportReader(250);
  const nativeExportRecords = exportReader.records;
  const directory = await mkdtemp(join(tmpdir(), "keepr-five-game-restore-"));
  const statePath = join(directory, "state");
  const migrationModule = join(directory, "fixture-migration.mjs");
  await build({
    entryPoints: ["test/support/source-adapters/migration.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: migrationModule,
  });
  const { syntheticSourceAdapterMigration } = await import(pathToFileURL(migrationModule).href);
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve("test/support/ingestion-worker.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  config.ratelimits[0].simple.limit = 300;
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  await applyMigrations(statePath, configPath, [syntheticSourceAdapterMigration]);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const adminKey = crypto.randomUUID(),
    apiKey = crypto.randomUUID();
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: adminKey, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: (request) => {
      const url = new URL(request.url);
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      assert.equal(url.hostname, "official-source.invalid");
      return Response.json(reconciliationSourceDocument(url.pathname.split("/").at(-1), "", request.url));
    },
  });
  let api;
  const consumerGet = async (url, options) => {
    await paceNativeRequest({ KEEPR_INGESTION_URL: api.url, KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250" });
    return fetch(url, options);
  };
  let journeyCompleted = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    if (journeyCompleted) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Failed five-game replay state retained at ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, adminKey, worker);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const environment = { KEEPR_INGESTION_URL: worker.url, KEEPR_ADMINISTRATION_KEY: adminKey };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  for (const area of ["card_facts", "printing_details"])
    await cli([
      "source",
      "designate",
      "--game",
      "riftbound",
      "--locale",
      "en",
      "--release-region",
      "US",
      "--source-lineage",
      "riftbound-en",
      "--area",
      area,
      "--expected-generation",
      "0",
      "--rationale",
      "Synthetic five-game fixture",
      "--idempotency-key",
      `five-${area}`,
    ]);
  const sources = [
    ["one-piece", "one-piece-en", "fixture-one-piece-json@3", "base"],
    ["fusion-world", "fusion-world-en", "fixture-fusion-world-json@2", "profile-fusion-world"],
    ["digimon", "digimon-en", "fixture-digimon-json@2", "profile-digimon"],
    ["gundam", "gundam-en-asia", "fixture-gundam-en-asia-json@2", "profile-gundam"],
    ["riftbound", "riftbound-en", "fixture-riftbound-json@1", "profile-riftbound"],
  ];
  const revisions = [];
  let previousComponents = [];
  const components = async (revision) => {
    const result = [];
    let after = null;
    do {
      const response = await consumerGet(
        `${api.url}/v1/catalogue-exports/${revision}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
      assert.equal(response.status, 200);
      const document = await response.json();
      result.push(...document.data.components);
      after = document.data.page.next_cursor;
    } while (after);
    return result;
  };
  let riftboundRun;
  for (const [game, lineage, adapter, scenario] of sources) {
    const planPath = join(directory, `${game}.json`);
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: game,
            source_lineage: lineage,
            adapter_version: adapter,
            requests: [
              { id: `${lineage}:discovery`, url: `https://official-source.invalid/reconciliation/${scenario}` },
            ],
          },
        ],
      }),
    );
    const source = await cli([
      "source",
      "collect",
      "--plan-file",
      planPath,
      "--idempotency-key",
      `five-source-${game}`,
    ]);
    if (game === "riftbound") riftboundRun = source.id;
    await cli(["source", "resume", "--run-id", source.id]);
    const collection = await waitForAdministrationDocument(
      `/v1/ingestion-runs/${source.id}/game-candidates`,
      (d) =>
        d.candidates.some((c) => ["failed", "paused"].includes(c.state))
          ? JSON.stringify(d)
          : d.candidates.length === 1 && d.candidates[0].state === "sealed",
      environment,
      worker,
      { deadlineMs: 120_000 },
    );
    const candidate = await cli(["game-candidate", "show", "--candidate-id", collection.candidates[0].id]);
    const published = await publishNativeCollection(
      { candidates: [candidate] },
      `five-publication-${game}`,
      environment,
      worker,
      120_000,
    );
    revisions.push(published.resulting_revision_id);
    const nextComponents = await components(published.resulting_revision_id);
    for (const sibling of previousComponents)
      assert.deepEqual(
        nextComponents.find((c) => c.name === sibling.name),
        sibling,
      );
    previousComponents = nextComponents;
  }
  const initialFiveRevision = revisions.at(-1);
  for (let repeat = 0; repeat < 3; repeat++) {
    const prepared = await cli([
      "game-candidate",
      "prepare",
      "--run-id",
      riftboundRun,
      "--game",
      "riftbound",
      "--expected-game-revision-id",
      revisions.at(-1),
      "--idempotency-key",
      `five-repeat-${repeat}`,
      "--yes",
    ]);
    const candidate = await waitForAdministrationDocument(
      `/v1/game-candidates/${prepared.id}`,
      (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
      environment,
      worker,
      { deadlineMs: 120_000 },
    );
    const published = await publishNativeCollection(
      { candidates: [candidate] },
      `five-repeat-publication-${repeat}`,
      environment,
      worker,
      120_000,
    );
    revisions.push(published.resulting_revision_id);
    const nextComponents = await components(published.resulting_revision_id);
    for (const sibling of previousComponents.filter((c) => !c.name.startsWith("riftbound.")))
      assert.deepEqual(
        nextComponents.find((c) => c.name === sibling.name),
        sibling,
      );
    previousComponents = nextComponents;
  }
  const cards = await nativeExportRecords(api.url, apiKey, revisions.at(-1), "cards");
  assert.deepEqual([...new Set(cards.map((c) => c.game))].sort(), sources.map(([game]) => game).sort());
  const headers = { authorization: `Bearer ${apiKey}` };
  const verifyRetainedReads = async () => {
    for (const revision of revisions.slice(-3))
      for (const card of cards) {
        const response = await consumerGet(`${api.url}/v1/cards/${card.id}?revision=${revision}`, { headers });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).data.id, card.id);
      }
    const retired = await consumerGet(`${api.url}/v1/cards/${cards[0].id}?revision=${initialFiveRevision}`, {
      headers,
    });
    assert.equal(retired.status, 503, await retired.clone().text());
    assert.equal((await retired.json()).code, "catalogue_query_unavailable");
  };
  await verifyRetainedReads();
  await stopWorker(api);
  await stopWorker(worker);
  const restored = await verifiedBackupApiState(statePath, directory);
  exportReader.clear();
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath: restored, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  assert.deepEqual(await nativeExportRecords(api.url, apiKey, revisions.at(-1), "cards"), cards);
  await verifyRetainedReads();
  journeyCompleted = true;
});
