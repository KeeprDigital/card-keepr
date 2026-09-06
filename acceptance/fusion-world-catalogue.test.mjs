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
const runStateDeadline = { deadlineMs: 25_000 };
const fixtureMarker = "card-keepr-acceptance-fusion-world-issue-32";
const failClosedCases = [
  "capped-leaf",
  "mismatched-detail",
  "missing-leader-face",
  "conflicting-locator",
  "energy-marker-rarity",
];

test("the owner publishes a complete Fusion World source for authenticated consumers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-fusion-world-"));
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "fusion-world-source-plan.json");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`, {
      mode: 0o600,
    }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: "fusion-world",
            source_lineage: "fusion-world-en",
            adapter_version: "fusion-world-en@9",
            requests: [
              {
                id: "fusion-world-en:discovery",
                url: "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
                headers: {
                  accept: "text/html",
                  "user-agent": fixtureMarker,
                },
              },
            ],
          },
        ],
      }),
      { mode: 0o600 },
    ),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
  delete config.$schema;
  config.main = resolve(root, "acceptance/fixtures/catalogue-publication-ingestion-harness.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-fusion-world-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = await startWorker({
    config: "acceptance/fixtures/fusion-world-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
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
  for (const [index, failureCase] of failClosedCases.entries()) {
    await setPlanMarker(planPath, `${fixtureMarker}-${failureCase}`);
    const rejectedCollection = await runCli(
      [
        "source",
        "collect",
        "--plan-file",
        planPath,
        "--idempotency-key",
        `fusion-world-issue-32-reject-${index}`,
        "--json",
      ],
      cliEnvironment,
    );
    assert.equal(rejectedCollection.code, 0, rejectedCollection.stderr);
    const rejectedRunId = JSON.parse(rejectedCollection.stdout).id;
    const rejectedResume = await runCli(["source", "resume", "--run-id", rejectedRunId, "--json"], cliEnvironment);
    assert.equal(rejectedResume.code, 0, rejectedResume.stderr);
    const rejected = await waitForRunState(rejectedRunId, "failed", cliEnvironment, ingestion, runStateDeadline);
    assert.equal(rejected.failure_code, "source_parse_failed", failureCase);
  }
  await setPlanMarker(planPath, fixtureMarker);
  const collected = await runCli(
    ["source", "collect", "--plan-file", planPath, "--idempotency-key", "fusion-world-issue-32-collect", "--json"],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, `${collected.stderr}\n${ingestion.getOutput()}`);
  const runId = JSON.parse(collected.stdout).id;
  const resumed = await runCli(["source", "resume", "--run-id", runId, "--json"], cliEnvironment);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(runId, "awaiting_approval", cliEnvironment, ingestion, runStateDeadline);

  const inspected = await runCli(["candidate", "inspect", "--run-id", runId, "--json"], cliEnvironment);
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.diff.summary.cards_added, 2);
  assert.equal(candidate.diff.summary.printings_added, 2);
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      runId,
      "--candidate-digest",
      candidate.candidate_digest,
      "--expected-current-revision",
      "catrev_spine_000",
      "--idempotency-key",
      "fusion-world-issue-32-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(approved.code, 0, `${approved.stderr}\n${ingestion.getOutput()}`);
  const revisionId = JSON.parse(approved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath,
  });
  t.after(() => stopWorker(api));
  await waitForHealth(`${api.url}/health`, apiKey, api);

  const headers = { authorization: `Bearer ${apiKey}` };
  const catalogueResponse = await fetch(`${api.url}/v1/catalogue`, { headers });
  assert.equal(catalogueResponse.status, 200);
  const catalogue = await catalogueResponse.json();

  assert.equal(Object.hasOwn(catalogue.data, "last_successful_checks"), false);

  const [cards, printings, images, products, releases, errata, distributionContexts, relationships] = await Promise.all(
    [
      "cards",
      "printings",
      "printing-images",
      "products",
      "releases",
      "errata",
      "distribution-contexts",
      "relationships",
    ].map((component) => exportRecords(api.port, apiKey, revisionId, component)),
  );
  assert.equal(cards.length, 2);
  assert.equal(printings.length, 2);
  assert.equal(products.length, 2);
  assert.equal(releases.length, 2);
  assert.equal(errata.length, 0);
  assert.equal(distributionContexts.length, 1);

  const card = cards.find(({ official_identity }) => official_identity.value === "FB99-001");
  const energyMarker = cards.find(({ official_identity }) => official_identity.value === "E-99");
  assert.ok(energyMarker, "the Energy Marker publishes as its own Card");
  assert.equal(card.effective_rules_text, "Official front skill");
  assert.deepEqual(card.game_data, {
    profile: "fusion-world@1",
    attributes: {
      card_type: "leader",
      colours: ["red"],
      cost: 1,
      specified_cost: [{ colour: "red", count: 1 }],
      power: 10000,
      combo_power: 5000,
      traits: ["Test"],
      skills: [{ kind: "ordinary", text: "Official front skill" }],
      leader_faces: [
        {
          role: "front",
          name: "Fusion Leader Front",
          power: 10000,
          traits: ["Test"],
          skills: "Official front skill",
        },
        {
          role: "back",
          name: "Fusion Leader Back",
          power: 15000,
          traits: ["Test"],
          skills: "Official back skill",
        },
      ],
    },
  });
  assert.equal(JSON.stringify(card.game_data).includes("FB99-001_p2"), false);
  const leaderPrinting = printings.find(({ card_id }) => card_id === card.id);
  const energyMarkerPrinting = printings.find(({ card_id }) => card_id === energyMarker.id);
  assert.equal(leaderPrinting.printed_rules_text, "Official front skill");

  assert.equal(Object.hasOwn(leaderPrinting, "locator_evidence"), false);

  assert.equal(Object.hasOwn(energyMarkerPrinting, "locator_evidence"), false);
  // fusion-world-en@9 carries an Energy Marker's absent rarity all the way to
  // the export as a null pair, rather than inventing a placeholder or failing;
  // every other family still publishes one.
  assert.deepEqual(energyMarkerPrinting.rarity, { raw: null, normalized: null });
  assert.deepEqual(leaderPrinting.rarity, { raw: "L", normalized: "l" });
  assert.equal(energyMarker.game_data.attributes.card_type, "energy_marker");
  assert.deepEqual(energyMarker.game_data.attributes.cost, null);
  assert.deepEqual(energyMarker.game_data.attributes.power, null);
  assert.deepEqual(energyMarker.game_data.attributes.traits, []);
  // The publisher tags an Energy Marker's dashed colour cell data-color
  // "no-color", which falls outside the fusion-world@1 colour vocabulary, so
  // reconciliation drops it to an unknown-vocabulary warning and the Card
  // publishes with no profile colour at all.
  assert.deepEqual(energyMarker.game_data.attributes.colours, []);
  assert.deepEqual(images.map(({ role }) => role).sort(), ["back", "front", "front"]);
  const availableProduct = products.find(({ official_code }) => official_code === "FB-RAW-01");
  const comingSoonProduct = products.find(({ official_code }) => official_code === "FB-COMING-02");
  const [cardCollection, printingCollection, productCollection] = await Promise.all([
    authenticatedApiJson(api.port, apiKey, "/v1/cards"),
    authenticatedApiJson(api.port, apiKey, "/v1/printings"),
    authenticatedApiJson(api.port, apiKey, "/v1/products"),
  ]);
  assert.deepEqual(cardCollection.data.map(({ id }) => id).sort(), cards.map(({ id }) => id).sort());
  assert.deepEqual(printingCollection.data.map(({ id }) => id).sort(), printings.map(({ id }) => id).sort());
  assert.deepEqual(productCollection.data.map(({ id }) => id).sort(), products.map(({ id }) => id).sort());
  assert.equal(availableProduct.name, "Fusion World Raw Product");
  assert.equal(comingSoonProduct.name, "Fusion World Coming Soon Product");
  assert.ok(
    releases.some(
      ({ product_id, region, status }) =>
        product_id === availableProduct.id && region === "EN-US" && status === "released",
    ),
  );
  assert.ok(
    releases.some(
      ({ product_id, region, status }) =>
        product_id === comingSoonProduct.id && region === "EN-US" && status === "announced",
    ),
  );
  assert.ok(distributionContexts.some(({ product_id }) => product_id === comingSoonProduct.id));
  // fusion-world-en@9 detail pages carry no publisher product code, so a
  // Printing binds to its "Where to get it" source bucket instead of a
  // Product; only the publisher's own Product surfaces relate to Products.
  assert.deepEqual([...new Set(relationships.map(({ kind }) => kind))].sort(), ["distribution-context-product"]);
});

async function setPlanMarker(planPath, marker) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.plans[0].requests[0].headers["user-agent"] = marker;
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
}

async function exportRecords(port, apiKey, revisionId, component) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/catalogue-exports/${revisionId}/components/${component}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 200);
  return gunzipSync(Buffer.from(await response.arrayBuffer()))
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function authenticatedApiJson(port, apiKey, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (response.status !== 200) {
    assert.fail(`${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}
