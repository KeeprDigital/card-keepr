import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { withNativeRequestPacing } from "./helpers/native-request-pacing.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

// Synthetic owner evidence, shipped native owner/publication Workflows and
// actual SQL export/import verification before authenticated consumer reads.
test("owner CLI publishes a reviewed split and authenticated consumers retain the replacement choice", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-corrections-"));
  const root = resolve(import.meta.dirname, "..");
  const statePath = join(directory, "state");
  const key = crypto.randomUUID();
  const ingestionEnv = join(directory, "ingestion.env"),
    apiEnv = join(directory, "api.env");
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${key}\nAPI_BEARER_KEY=${key}\nADMINISTRATION_CLOCK_MODE=request\n`,
  );
  await writeFile(apiEnv, `API_BEARER_KEY=${key}\n`);
  const config = await readWorkerConfig(join(root, "apps/ingestion/wrangler.jsonc"));
  delete config.$schema;
  config.main = join(root, "acceptance/fixtures/native-combined-card-keepr-runtime.ts");
  config.d1_databases[0].migrations_dir = join(root, "migrations");
  // Finite journey allowance, shared by CLI, polling and owner inspection requests.
  config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 300;
  config.services = [{ binding: "OFFICIAL_SOURCE_TRANSPORT", service: "card-keepr-synthetic-official-source" }];
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source"),
  });
  const ingestion = await startWorker({
    ...checkpoint,
    config: configPath,
    envFile: ingestionEnv,
    statePath,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
  });
  let api;
  let journeyCompleted = false;
  t.after(async () => {
    if (!journeyCompleted) await writeFile(join(directory, "failure-runtime.log"), ingestion.getOutput());
    await Promise.all([stopWorker(source), stopWorker(ingestion), ...(api ? [stopWorker(api)] : [])]);
    if (journeyCompleted) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Failed identity CLI state retained at ${directory}`);
  });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: key,
    // Pace the complete journey below its 300/minute fixture allowance.
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const file = join(directory, "proposal.json");
  const ids = [],
    cardIds = [];
  for (const name of ["Conflated", "Left", "Right"]) {
    await writeFile(
      file,
      JSON.stringify({
        game: "one-piece",
        source_lineage: "owner",
        reference: name,
        content: {
          card: {
            game: "one-piece",
            official_identity: { kind: "unknown", value: null },
            name,
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
          printing: {
            rarity: { raw: null, normalized: null },
            printed_rules_text: null,
            game_data: { profile: "one-piece@1", attributes: { illustration_types: [] } },
          },
        },
        evidence: { attestation: "Synthetic owner physical inspection" },
        idempotency_key: name,
      }),
    );
    const p = await cli(["entity-proposal", "create", "--proposal", file, "--yes"]);
    await writeFile(
      file,
      JSON.stringify({
        expected_generation: "0",
        rationale: "Synthetic identity established",
        exception: { scope: ["identity"], attestation: "Synthetic issued artwork" },
        idempotency_key: `${name}-admit`,
      }),
    );
    const admitted = await cli(["entity-proposal", "admit", "--proposal-id", p.id, "--decision", file, "--yes"]);
    ids.push(admitted.history[0].decision.printing.id);
    cardIds.push(admitted.history[0].decision.card.id);
  }
  async function publish(idempotencyKey, expected) {
    const collected = await withNativeRequestPacing(environment, () =>
      fetch(`${ingestion.url}/acceptance/synthetic-evidence`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "fixture-one-piece-json@3",
          idempotency_key: idempotencyKey,
          requests: [{ id: "one-piece-en:discovery", url: "https://shared-profile-source.invalid/nested" }],
        }),
      }),
    );
    const run = await collected.json();
    assert.equal(collected.status, 201, JSON.stringify(run));
    const prepared = await cli([
      "game-candidate",
      "prepare",
      "--run-id",
      run.id,
      "--game",
      "one-piece",
      "--expected-game-revision-id",
      expected,
      "--idempotency-key",
      `${idempotencyKey}-prepare`,
      "--yes",
    ]);
    const candidate = await waitForAdministrationDocument(
      `/v1/game-candidates/${prepared.id}`,
      (document) =>
        document.state === "sealed" ||
        (["failed", "paused"].includes(document.state) ? JSON.stringify(document) : false),
      environment,
      ingestion,
    );
    assert.equal(candidate.expected_game_revision_id, expected);
    const reviewed = await cli([
      "game-candidate",
      "inspect",
      "--candidate-id",
      candidate.id,
      "--manifest",
      candidate.manifest_digest,
    ]);
    assert.equal(reviewed.ready, true);
    assert.equal(reviewed.manifest_digest, candidate.manifest_digest);
    const inspection = await inspectNativeCollection(run.id, environment);
    assert.equal(inspection.candidates.length, 1);
    assert.equal(inspection.candidates[0].id, candidate.id);
    return publishNativeCollection(inspection, `${idempotencyKey}-approve`, environment, ingestion);
  }
  const initial = await publish("initial", "catrev_spine_000");
  const merge = {
    game: "one-piece",
    entity_kind: "card",
    action: "merge",
    source_ids: [cardIds[0]],
    replacement_ids: [cardIds[1]],
    printing_assignments: {},
    expected_current_revision_id: initial.resulting_revision_id,
    rationale: "Synthetic duplicate rules-level Card",
    evidence: { attestation: "Synthetic owner review establishes a single survivor" },
  };
  await writeFile(file, JSON.stringify(merge));
  const mergeReview = await cli(["identity-correction", "validate", "--proposal", file]);
  await writeFile(
    file,
    JSON.stringify({ ...merge, review_digest: mergeReview.review_digest, idempotency_key: "merge" }),
  );
  await cli(["identity-correction", "create", "--proposal", file, "--yes"]);
  const proposal = {
    game: "one-piece",
    entity_kind: "printing",
    action: "split",
    source_ids: [ids[0]],
    replacement_ids: ids.slice(1),
    printing_assignments: {},
    expected_current_revision_id: initial.resulting_revision_id,
    rationale: "Two distinct printings were conflated",
    evidence: { attestation: "Synthetic inspection establishing both replacements" },
  };
  await writeFile(file, JSON.stringify(proposal));
  const validation = await cli(["identity-correction", "validate", "--proposal", file]);
  await writeFile(
    file,
    JSON.stringify({ ...proposal, review_digest: validation.review_digest, idempotency_key: "split" }),
  );
  const decision = await cli(["identity-correction", "create", "--proposal", file, "--yes"]);
  assert.equal((await cli(["identity-correction", "inspect", "--correction-id", decision.id])).action, "split");
  assert.equal((await cli(["identity-correction", "list", "--game", "one-piece"])).decisions.length, 2);
  const publication = await publish("corrected", initial.resulting_revision_id);
  await stopWorker(ingestion);
  api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
  await waitForHealth(`${api.url}/health`, key, api);
  const merged = await fetch(`${api.url}/v1/cards/${cardIds[0]}`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(merged.status, 200);
  const redirect = await merged.json();
  assert.equal(redirect.data.action, "merge");
  assert.equal(redirect.data.links.survivor, `${api.url}/v1/cards/${cardIds[1]}`);
  assert.deepEqual(redirect.data.replacement_ids, [cardIds[1]]);
  const url = `${api.url}/v1/printings/${ids[0]}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  const result = await response.json();
  assert.equal(result.meta.catalogue_revision_id, publication.resulting_revision_id);
  assert.equal(result.data.type, "identity_correction");
  assert.deepEqual(result.data.replacement_ids, ids.slice(1));
  assert.equal(result.data.links.survivor, undefined);
  assert.equal(result.data.evidence, undefined);
  assert.equal(result.data.rationale, undefined);
  for (const link of result.data.links.replacements) {
    const replacement = await fetch(link, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(replacement.status, 200);
    assert.equal((await replacement.json()).data.type, "printing");
  }
  const conditional = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, "if-none-match": response.headers.get("etag") },
  });
  assert.equal(conditional.status, 304);
  journeyCompleted = true;
});
