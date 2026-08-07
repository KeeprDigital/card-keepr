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
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify({
        plans: [{
          supported_game: "fusion-world",
          source_lineage: "fusion-world-en",
          adapter_version: "fusion-world-en@4",
          requests: [{
            id: "fusion-world-en:discovery",
            url: "https://www.dbs-cardgame.com/fw/en/cardlist/",
            headers: {
              accept: "text/html",
              "user-agent": fixtureMarker,
            },
          }],
        }],
      }),
      { mode: 0o600 },
    ),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(
    await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.main = resolve(
    root,
    "acceptance/fixtures/catalogue-publication-ingestion-harness.ts",
  );
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [{
    binding: "OFFICIAL_SOURCE_TRANSPORT",
    service: "card-keepr-fusion-world-official-source",
  }];
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
    const rejectedCollection = await runCli([
      "source", "collect", "--plan-file", planPath,
      "--idempotency-key", `fusion-world-issue-32-reject-${index}`, "--json",
    ], cliEnvironment);
    assert.equal(rejectedCollection.code, 0, rejectedCollection.stderr);
    const rejectedRunId = JSON.parse(rejectedCollection.stdout).id;
    const rejectedResume = await runCli(
      ["source", "resume", "--run-id", rejectedRunId, "--json"],
      cliEnvironment,
    );
    assert.equal(rejectedResume.code, 0, rejectedResume.stderr);
    const rejected = await waitForRunState(
      rejectedRunId,
      "failed",
      cliEnvironment,
      ingestion,
      runStateDeadline,
    );
    assert.equal(rejected.failure_code, "source_parse_failed", failureCase);
  }
  await setPlanMarker(planPath, fixtureMarker);
  const collected = await runCli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "fusion-world-issue-32-collect",
    "--json",
  ], cliEnvironment);
  assert.equal(collected.code, 0, `${collected.stderr}\n${ingestion.getOutput()}`);
  const runId = JSON.parse(collected.stdout).id;
  const resumed = await runCli(
    ["source", "resume", "--run-id", runId, "--json"],
    cliEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(
    runId,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
    runStateDeadline,
  );

  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", runId, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.diff.summary.cards_added, 1);
  assert.equal(candidate.diff.summary.printings_added, 1);
  const approved = await runCli([
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
  ], cliEnvironment);
  assert.equal(approved.code, 0, `${approved.stderr}\n${ingestion.getOutput()}`);
  const firstRevisionId = JSON.parse(approved.stdout).resulting_revision_id;

  const errataPlan = JSON.parse(await readFile(planPath, "utf8"));
  errataPlan.plans[0].requests[0].headers["user-agent"] = `${fixtureMarker}-errata`;
  await writeFile(planPath, JSON.stringify(errataPlan), { mode: 0o600 });
  const errataCollected = await runCli([
    "source", "collect", "--plan-file", planPath,
    "--idempotency-key", "fusion-world-issue-32-errata-collect", "--json",
  ], cliEnvironment);
  assert.equal(
    errataCollected.code,
    0,
    `${errataCollected.stderr}\n${ingestion.getOutput()}`,
  );
  const errataRunId = JSON.parse(errataCollected.stdout).id;
  const errataResumed = await runCli(
    ["source", "resume", "--run-id", errataRunId, "--json"],
    cliEnvironment,
  );
  assert.equal(errataResumed.code, 0, errataResumed.stderr);
  await waitForRunState(
    errataRunId,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
    runStateDeadline,
  );
  const errataInspected = await runCli(
    ["candidate", "inspect", "--run-id", errataRunId, "--json"],
    cliEnvironment,
  );
  assert.equal(errataInspected.code, 0, errataInspected.stderr);
  const errataCandidate = JSON.parse(errataInspected.stdout);
  const errataApproved = await runCli([
    "run", "approve", "--run-id", errataRunId,
    "--candidate-digest", errataCandidate.candidate_digest,
    "--expected-current-revision", firstRevisionId,
    "--idempotency-key", "fusion-world-issue-32-errata-approve",
    "--yes", "--json",
  ], cliEnvironment);
  assert.equal(
    errataApproved.code,
    0,
    `${errataApproved.stderr}\n${ingestion.getOutput()}`,
  );
  const revisionId = JSON.parse(errataApproved.stdout).resulting_revision_id;
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
  assert.deepEqual(
    catalogue.data.last_successful_checks
      .filter(({ game }) => game === "fusion-world")
      .map(({ area }) => area),
    [
      "cards-and-printings",
      "errata",
      "legality-rules",
      "products-and-releases",
    ],
  );

  const [
    cards,
    printings,
    images,
    products,
    releases,
    errata,
    legalityRules,
    distributionContexts,
    relationships,
  ] =
    await Promise.all([
      "cards",
      "printings",
      "printing-images",
      "products",
      "releases",
      "errata",
      "legality-rules",
      "distribution-contexts",
      "relationships",
    ].map((component) =>
      exportRecords(api.port, apiKey, revisionId, component)
    ));
  assert.equal(cards.length, 1);
  assert.equal(printings.length, 1);
  assert.equal(products.length, 2);
  assert.equal(releases.length, 2);
  assert.equal(errata.length, 1);
  assert.equal(legalityRules.length, 2);
  assert.equal(distributionContexts.length, 2);

  const card = cards[0];
  assert.equal(card.official_identity.value, "FB99-001");
  assert.equal(card.effective_rules_text, "Official corrected rules");
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
      skills: [{ kind: "ordinary", text: "Official printed rules" }],
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
  assert.equal(printings[0].printed_rules_text, "Official printed rules");
  assert.deepEqual(
    printings[0].locator_evidence.current.map(({ locator }) => locator),
    ["FB99-001_p2"],
  );
  assert.deepEqual(images.map(({ role }) => role).sort(), ["back", "front"]);
  const availableProduct = products.find(
    ({ official_code }) => official_code === "FB-RAW-01",
  );
  const comingSoonProduct = products.find(
    ({ official_code }) => official_code === "FB-COMING-02",
  );
  const [cardCollection, printingCollection, productCollection, legalityStatus] =
    await Promise.all([
      authenticatedApiJson(api.port, apiKey, "/v1/cards"),
      authenticatedApiJson(api.port, apiKey, "/v1/printings"),
      authenticatedApiJson(api.port, apiKey, "/v1/products"),
      authenticatedApiJson(
        api.port,
        apiKey,
        `/v1/legality-status?card_id=${encodeURIComponent(card.id)}` +
          "&on=2026-08-04&format=standard&region=EN-OCEANIA",
      ),
    ]);
  assert.deepEqual(cardCollection.data.map(({ id }) => id), [card.id]);
  assert.deepEqual(
    printingCollection.data.map(({ id }) => id),
    [printings[0].id],
  );
  assert.deepEqual(
    productCollection.data.map(({ id }) => id).sort(),
    products.map(({ id }) => id).sort(),
  );
  assert.deepEqual(
    legalityStatus.data.map(({ card_id, region, status, rule_ids }) => ({
      card_id,
      region,
      status,
      rule_ids,
    })),
    [{
      card_id: card.id,
      region: "EN-OCEANIA",
      status: "legal",
      rule_ids: [legalityRules.find(
        ({ official_id }) => official_id === "fusion-world-current-fb99-001",
      ).id],
    }],
  );
  assert.equal(availableProduct.name, "Fusion World Raw Product");
  assert.equal(
    comingSoonProduct.name,
    "Fusion World Coming Soon Product",
  );
  assert.ok(releases.some(
    ({ product_id, region, status }) =>
      product_id === availableProduct.id &&
      region === "EN-US" &&
      status === "released",
  ));
  assert.ok(releases.some(
    ({ product_id, region, status }) =>
      product_id === comingSoonProduct.id &&
      region === "EN-US" &&
      status === "announced",
  ));
  assert.deepEqual(
    legalityRules.map(({ official_id }) => official_id).sort(),
    [
      "fusion-world-current-fb99-001",
      "fusion-world-history-fb99-001",
    ],
  );
  assert.ok(legalityRules.every(({ card_ids }) =>
    card_ids.length === 1 && card_ids[0] === card.id
  ));
  assert.ok(distributionContexts.some(
    ({ product_id }) => product_id === comingSoonProduct.id,
  ));
  for (const kind of [
    "printing-product",
    "product-card",
    "printing-distribution-context",
    "distribution-context-product",
    "legality-rule-card",
  ]) {
    assert.ok(relationships.some((relationship) => relationship.kind === kind));
  }
  assert.equal(errata[0].target_id, card.id);
  assert.equal(errata[0].effective_from, "2026-07-15");
  assert.equal(errata[0].corrected_value, "Official corrected rules");
});

async function setPlanMarker(planPath, marker) {
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  plan.plans[0].requests[0].headers["user-agent"] = marker;
  await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
}

async function exportRecords(port, apiKey, revisionId, component) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/catalogue-exports/${revisionId}/components/${component}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
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
