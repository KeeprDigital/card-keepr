import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");

test("the owner publishes a complete One Piece catalogue for authenticated consumers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-one-piece-"));
  const statePath = join(directory, "state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "plan.json");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
      mode: 0o600,
    }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(planPath, JSON.stringify(completePlan("card-keepr-one-piece-complete-v1")), { mode: 0o600 }),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve(root, "acceptance/fixtures/catalogue-publication-ingestion-harness.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-synthetic-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath,
  });
  let api;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), ...(api ? [stopWorker(api)] : [])]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(`${source.url}/catalogue-discovery`, "", source),
    waitForHealth(`${ingestion.url}/health`, administrationKey, ingestion),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "one-piece-complete-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], cliEnvironment);
  assert.equal(resumed.code, 0, resumed.stderr);
  const ready = await waitForRunState(run.id, "awaiting_approval", cliEnvironment, {
    getOutput: () => `${ingestion.getOutput()}\n${source.getOutput()}`,
  });
  assert.ok(
    ready.snapshots.every(({ content }) => /^[0-9a-f]{64}$/u.test(content.digest)),
    "every collected surface and image is retained with provenance",
  );
  assert.deepEqual(
    ready.evidence_plans[0].requests.map(({ id }) => id),
    ["one-piece-en:discovery"],
    "the immutable Evidence Plan remains the single discovery request",
  );
  assert.ok(ready.snapshots.some(({ request }) => new URL(request.url).searchParams.get("series") === "2201"));
  assert.ok(ready.snapshots.some(({ request }) => new URL(request.url).searchParams.get("series") === "2202"));
  for (const [recording, expectedCount] of [
    ["2201", 1],
    ["2202", 2],
  ]) {
    const snapshot = ready.snapshots.find(
      ({ request }) => new URL(request.url).searchParams.get("series") === recording,
    );
    const observationSet = ready.observation_sets.find(({ source_snapshot_id }) => source_snapshot_id === snapshot.id);
    assert.equal(observationSet.observation_count, expectedCount);
  }

  const inspected = await runCli(["candidate", "inspect", "--run-id", run.id, "--json"], cliEnvironment);
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.diff.summary.cards_added, 3);
  assert.equal(candidate.diff.summary.printings_added, 2);
  assert.ok(
    candidate.diff.warnings.some(
      ({ code, raw_value }) => code === "unknown_source_field" && raw_value === "New optional publisher vocabulary",
    ),
  );
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      run.id,
      "--candidate-digest",
      candidate.candidate_digest,
      "--expected-current-revision",
      "catrev_spine_000",
      "--idempotency-key",
      "one-piece-complete-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(approved.code, 0, `${approved.stdout}\n${approved.stderr}\n${ingestion.getOutput()}`);
  const catalogueRevisionId = JSON.parse(approved.stdout).resulting_revision_id;

  await writeFile(planPath, JSON.stringify(completePlan("card-keepr-one-piece-complete-errata-v1")), { mode: 0o600 });
  const errataCollected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "one-piece-complete-errata-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(errataCollected.code, 0, errataCollected.stderr);
  const errataRun = JSON.parse(errataCollected.stdout);
  const errataResumed = await runCli(["source", "resume", "--run-id", errataRun.id, "--json"], cliEnvironment);
  assert.equal(errataResumed.code, 0, errataResumed.stderr);
  await waitForRunState(errataRun.id, "awaiting_approval", cliEnvironment, {
    getOutput: () => `${ingestion.getOutput()}\n${source.getOutput()}`,
  });
  const errataInspected = await runCli(["candidate", "inspect", "--run-id", errataRun.id, "--json"], cliEnvironment);
  assert.equal(errataInspected.code, 0, errataInspected.stderr);
  const errataCandidate = JSON.parse(errataInspected.stdout);
  const errataApproved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      errataRun.id,
      "--candidate-digest",
      errataCandidate.candidate_digest,
      "--expected-current-revision",
      catalogueRevisionId,
      "--idempotency-key",
      "one-piece-complete-errata-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(errataApproved.code, 0, `${errataApproved.stdout}\n${errataApproved.stderr}\n${ingestion.getOutput()}`);
  const revisionId = JSON.parse(errataApproved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath,
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const [cards, printings, images, products, releases, errata] = await Promise.all(
    ["cards", "printings", "printing-images", "products", "releases", "errata"].map((component) =>
      exportRecords(api.port, apiKey, revisionId, component),
    ),
  );
  assert.equal(cards.length, 3);
  assert.equal(printings.length, 2);
  assert.equal(images.length, 2);
  assert.equal(products.length, 1);
  assert.equal(releases.length, 1);
  assert.equal(errata.length, 1);

  const leader = cards.find(({ official_identity }) => official_identity.value === "OP31-001");
  assert.deepEqual(leader.game_data, {
    profile: "one-piece@1",
    attributes: {
      card_type: "leader",
      colours: ["green", "red"],
      cost: null,
      life: 5,
      battle_attributes: ["strike"],
      power: 5000,
      counter: null,
      traits: ["Straw Hat Crew"],
      block_icons: ["1"],
      effect_text: "Give up to 1 rested DON!! card to this Leader.",
      trigger_text: null,
    },
  });
  assert.equal(leader.effective_rules_text, "Give up to 2 rested DON!! cards to this Leader.");
  assert.equal(errata[0].target_id, leader.id);
  assert.equal(errata[0].corrected_value, "Give up to 2 rested DON!! cards to this Leader.");
  const don = cards.find(({ official_identity }) => official_identity.kind === "functional_designation");
  assert.deepEqual(don.official_identity, {
    kind: "functional_designation",
    value: "DON!!",
  });
  assert.equal(don.game_data.attributes.card_type, "don");
  assert.equal(
    printings.some(({ card_id }) => card_id === don.id),
    false,
    "the generic DON!! Card makes no comprehensive Printing promise",
  );

  const leaderPrinting = printings.find(({ card_id }) => card_id === leader.id);
  assert.equal(leaderPrinting.printed_rules_text, "Give up to 1 rested DON!! card to this Leader.");
  const cardResponse = await fetch(`${api.url}/v1/cards/${leader.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(cardResponse.status, 200);
  assert.equal(
    (await cardResponse.json()).data.effective_rules_text,
    "Give up to 2 rested DON!! cards to this Leader.",
  );
  const printingResponse = await fetch(`${api.url}/v1/printings/${leaderPrinting.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(printingResponse.status, 200);
  const printingDocument = await printingResponse.json();

  assert.equal(Object.hasOwn(printingDocument.data, "locator_evidence"), false);
});

function completePlan(userAgent) {
  return {
    plans: [
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "one-piece-en@6",
        requests: [
          {
            id: "one-piece-en:discovery",
            url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
            headers: { accept: "text/html", "user-agent": userAgent },
          },
        ],
      },
    ],
  };
}

async function exportRecords(port, apiKey, revisionId, component) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/catalogue-exports/${revisionId}/components/${component}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 200);
  const body = gunzipSync(Buffer.from(await response.arrayBuffer()))
    .toString("utf8")
    .trim();
  return body === "" ? [] : body.split("\n").map((line) => JSON.parse(line));
}
