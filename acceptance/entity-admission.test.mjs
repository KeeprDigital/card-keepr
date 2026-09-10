import { collectNativeFixtureSource } from "./helpers/native-catalogue-runtime.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
  waitForNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

// Synthetic owner attestation and source fixtures; no real-card evidence claim.
test("owner CLI admission remains administrative until publication and serves ordinary authenticated consumers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-entity-admission-"));
  const root = resolve(import.meta.dirname, "..");
  const statePath = join(directory, "state");
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const key = crypto.randomUUID();
  await writeFile(ingestionEnv, `ADMINISTRATION_KEY=${key}\nADMINISTRATION_CLOCK_MODE=request\n`);
  await writeFile(apiEnv, `API_BEARER_KEY=${key}\n`);
  const config = JSON.parse(await readFile(join(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = join(root, "acceptance/fixtures/native-retained-evidence-harness.ts");
  config.d1_databases[0].migrations_dir = join(root, "migrations");
  // This journey exercises admission/publication; the fixture budget covers its bounded inspection requests.
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 300;
  config.services = [{ binding: "OFFICIAL_SOURCE_TRANSPORT", service: "card-keepr-synthetic-official-source" }];
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source"),
  });
  const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const ingestion = await startWorker({
    ...checkpointTransport,
    config: configPath,
    envFile: ingestionEnv,
    statePath,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
  });
  let api;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), ...(api ? [stopWorker(api)] : [])]);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const collectNativeSource = (lineage, adapter, url, key) =>
    collectNativeFixtureSource(directory, environment, lineage, adapter, url, key);

  const proposalPath = join(directory, "proposal.json");
  const decisionPath = join(directory, "decision.json");
  await writeFile(
    proposalPath,
    JSON.stringify({
      game: "one-piece",
      source_lineage: "owner",
      reference: "synthetic-owner-card",
      content: {
        card: {
          game: "one-piece",
          official_identity: { kind: "unknown", value: null },
          name: "Synthetic owner Card",
          effective_rules_text: null,
          game_data: {
            profile: "one-piece@1",
            attributes: {
              card_type: "character",
              colours: ["red"],
              cost: 1,
              life: null,
              battle_attributes: [],
              power: 1000,
              counter: null,
              traits: [],
              block_icons: [],
              effect_text: null,
              trigger_text: null,
            },
          },
        },
      },
      evidence: { attestation: "Synthetic test of owner's personal inspection, not a live-source finding." },
      idempotency_key: "create",
    }),
  );
  const proposed = await cli(["entity-proposal", "create", "--proposal", proposalPath, "--yes"]);
  assert.equal(proposed.status, "unresolved");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "0",
      rationale: "Synthetic rejection before further inspection",
      idempotency_key: "reject",
    }),
  );
  const rejected = await cli([
    "entity-proposal",
    "reject",
    "--proposal-id",
    proposed.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  assert.equal(rejected.status, "rejected");
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "1",
      rationale: "Owner explicitly reconsiders",
      idempotency_key: "reconsider",
    }),
  );
  await cli(["entity-proposal", "reconsider", "--proposal-id", proposed.id, "--decision", decisionPath, "--yes"]);
  await writeFile(
    decisionPath,
    JSON.stringify({
      expected_generation: "2",
      rationale: "Owner establishes the identity",
      idempotency_key: "admit",
      exception: {
        scope: ["identity", "source_evidence"],
        attestation: "Synthetic owner inspection establishes a distinct real-card identity.",
      },
    }),
  );
  const admitted = await cli([
    "entity-proposal",
    "admit",
    "--proposal-id",
    proposed.id,
    "--decision",
    decisionPath,
    "--yes",
  ]);
  const cardId = admitted.history[2].decision.card.id;
  assert.equal(admitted.status, "admitted");
  assert.equal((await cli(["entity-proposal", "inspect", "--proposal-id", proposed.id])).history.length, 3);
  assert.equal((await cli(["entity-proposal", "list", "--game", "one-piece"])).proposals[0].id, proposed.id);
  const run = await collectNativeSource(
    "one-piece-en",
    "fixture-one-piece-json@3",
    "https://shared-profile-source.invalid/nested",
    "collect",
  );
  await waitForNativeCollection(run.id, "sealed", environment, ingestion);
  const candidate = await inspectNativeCollection(run.id, environment);
  assert.ok(candidate.warnings.some((warning) => warning.code === "entity_admission"));
  const approved = await publishNativeCollection(candidate, "approve-admitted", environment, ingestion);
  assert.ok(approved.resulting_revision_id);
  await stopWorker(ingestion);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
  await waitForHealth(`${api.url}/health`, key, api);
  const anonymous = await fetch(`${api.url}/v1/cards/${cardId}`);
  assert.equal(anonymous.status, 401);
  const response = await fetch(`${api.url}/v1/cards/${cardId}`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.data.name, "Synthetic owner Card");
  assert.deepEqual(card.data.official_identity, { kind: "unknown", value: null });
  assert.equal(card.data.evidence, undefined);
  assert.equal(card.data.admission, undefined);
  assert.equal(card.data.provenance, undefined);
});
