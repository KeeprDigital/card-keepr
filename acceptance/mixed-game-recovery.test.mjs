import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { reconciliationSourceDocument } from "../test/support/fake-publisher/reconciliation-documents.ts";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForAdministrationDocument,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";
import { nativeCheckpointTransport, publishNativeCollection } from "./helpers/native-catalogue-runtime.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { withNativeRequestPacing } from "./helpers/native-request-pacing.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";

// Synthetic source facts, actual publication/backup Workflows and SQL imports.
// Two games prove sibling preservation; three further publications cross the
// current-plus-two retention boundary. No full catalogue or capacity preflight.
test("mixed-game composition and current plus two survive an actual SQL import", async (t) => {
  const exportReader = nativeExportReader(250);
  const nativeExportRecords = exportReader.records;
  const directory = await mkdtemp(join(tmpdir(), "keepr-mixed-game-restore-"));
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
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("acceptance/fixtures/native-retained-evidence-harness.ts");
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
      const document = reconciliationSourceDocument(url.pathname.split("/").at(-1), "", request.url);
      if (url.searchParams.has("revision"))
        document.cards[0].card.name = `Agumon revision ${url.searchParams.get("revision")}`;
      return Response.json(document);
    },
  });
  let api;
  const consumerGet = (url, options) =>
    withNativeRequestPacing({ KEEPR_INGESTION_URL: api.url, KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250" }, () =>
      fetch(url, options),
    );
  t.after(async () => {
    if (api) await stopWorker(api);
    await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
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
  const sources = [
    ["one-piece", "one-piece-en", "fixture-one-piece-json@3", "base"],
    ["digimon", "digimon-en", "fixture-digimon-json@2", "profile-digimon"],
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
  const planPath = join(directory, "mixed-games.json");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: sources.map(([game, lineage, adapter, scenario]) => ({
        supported_game: game,
        source_lineage: lineage,
        adapter_version: adapter,
        requests: [{ id: `${lineage}:discovery`, url: `https://official-source.invalid/reconciliation/${scenario}` }],
      })),
    }),
  );
  // A declared multi-game collection selects the shipped native preparation
  // path. Single-game synthetic adapters intentionally retain the legacy path.
  const source = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "mixed-game-source"]);
  await cli(["source", "resume", "--run-id", source.id]);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${source.id}/evidence`,
    (d) =>
      d.state === "parsing" ||
      (["failed", "paused", "awaiting_approval"].includes(d.state)
        ? `Expected native collection preparation, observed ${d.state}`
        : false),
    environment,
    worker,
    { deadlineMs: 120_000 },
  );
  const collection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${source.id}/game-candidates`,
    (d) =>
      d.candidates.some((c) => ["failed", "paused"].includes(c.state))
        ? JSON.stringify(d)
        : d.candidates.length === sources.length && d.candidates.every((c) => c.state === "sealed"),
    environment,
    worker,
    { deadlineMs: 120_000 },
  );
  assert.deepEqual(collection.candidates.map((c) => c.supported_game).sort(), sources.map(([game]) => game).sort());
  for (const [game] of sources) {
    const selected = collection.candidates.find((c) => c.supported_game === game);
    const candidate = await cli(["game-candidate", "show", "--candidate-id", selected.id]);
    const published = await publishNativeCollection(
      { candidates: [candidate] },
      `mixed-publication-${game}`,
      environment,
      worker,
      120_000,
    );
    assert.ok(!revisions.includes(published.resulting_revision_id));
    revisions.push(published.resulting_revision_id);
    const nextComponents = await components(published.resulting_revision_id);
    for (const sibling of previousComponents)
      assert.deepEqual(
        nextComponents.find((c) => c.name === sibling.name),
        sibling,
      );
    previousComponents = nextComponents;
  }
  const initialCompositionRevision = revisions.at(-1);
  for (let repeat = 0; repeat < 3; repeat++) {
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: "digimon",
            source_lineage: "digimon-en",
            adapter_version: "fixture-digimon-json@2",
            requests: [
              {
                id: "digimon-en:refresh",
                url: `https://official-source.invalid/reconciliation/profile-digimon?revision=${repeat}`,
              },
            ],
          },
        ],
      }),
    );
    const refreshed = await cli([
      "source",
      "collect",
      "--plan-file",
      planPath,
      "--idempotency-key",
      `mixed-refresh-${repeat}`,
    ]);
    assert.equal(refreshed.state, "parsing");
    const prepared = await fetch(`${worker.url}/v1/game-candidates`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: refreshed.id,
        supported_game: "digimon",
        expected_game_revision_id: revisions.at(-1),
        idempotency_key: `mixed-refresh-candidate-${repeat}`,
      }),
    });
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const refreshedCollection = await waitForAdministrationDocument(
      `/v1/ingestion-runs/${refreshed.id}/game-candidates`,
      (d) => d.candidates.length === 1 && d.candidates[0].state === "sealed",
      environment,
      worker,
      { deadlineMs: 30000 },
    );
    const candidate = await cli(["game-candidate", "show", "--candidate-id", refreshedCollection.candidates[0].id]);
    const published = await publishNativeCollection(
      { candidates: [candidate] },
      `mixed-repeat-publication-${repeat}`,
      environment,
      worker,
      120_000,
    );
    assert.ok(!revisions.includes(published.resulting_revision_id));
    revisions.push(published.resulting_revision_id);
    const nextComponents = await components(published.resulting_revision_id);
    for (const sibling of previousComponents.filter((c) => !c.name.startsWith("digimon.")))
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
    const retired = await consumerGet(`${api.url}/v1/cards/${cards[0].id}?revision=${initialCompositionRevision}`, {
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
});
