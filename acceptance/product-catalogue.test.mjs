import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const ingestionPort = 22_788;
const apiPort = 22_789;
const sourcePort = 22_790;

test("the CLI publishes separated Product catalogue data consumed through authenticated HTTP", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-product-boundary-"),
  );
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const initialPlanPath = join(directory, "initial-source-plan.json");
  const multiPlanPath = join(directory, "multi-source-plan.json");
  const carryPlanPath = join(directory, "carry-source-plan.json");
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      initialPlanPath,
      JSON.stringify({
        plans: [
          officialPlan("digimon", "digimon-en", "digimon-en@1"),
        ],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      multiPlanPath,
      JSON.stringify({
        plans: [
          officialPlan("digimon", "digimon-en", "digimon-en@1"),
          officialPlan(
            "one-piece",
            "one-piece-en",
            "one-piece-json-document@2",
          ),
          officialPlan(
            "fusion-world",
            "fusion-world-en",
            "fusion-world-en@1",
          ),
          officialPlan(
            "gundam",
            "gundam-en-asia",
            "gundam-en-asia@1",
          ),
          officialPlan(
            "gundam",
            "gundam-en-us",
            "gundam-en-us@1",
          ),
        ],
      }),
      { mode: 0o600 },
    ),
    writeFile(
      carryPlanPath,
      JSON.stringify({
        plans: [
          officialPlan(
            "one-piece",
            "one-piece-en",
            "one-piece-json-document@2",
          ),
        ],
      }),
      { mode: 0o600 },
    ),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(
    await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-synthetic-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    inspectorPort: 23_229,
    port: sourcePort,
    statePath: join(directory, "source-state"),
  });
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 23_230,
    port: ingestionPort,
    statePath,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(
      `http://127.0.0.1:${sourcePort}/catalogue-discovery`,
      "",
      source,
    ),
    waitForHealth(
      `http://127.0.0.1:${ingestionPort}/health`,
      administrationKey,
      ingestion,
    ),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const collected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      initialPlanPath,
      "--idempotency-key",
      "acceptance-product-collect",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    collected.code,
    0,
    `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`,
  );
  const collectedRun = JSON.parse(collected.stdout);
  const resumed = await runCli(
    ["source", "resume", "--run-id", collectedRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(
    collectedRun.id,
    "parsing",
    cliEnvironment,
    ingestion,
  );
  const reconciled = await runCli(
    ["run", "reconcile", "--run-id", collectedRun.id, "--json"],
    cliEnvironment,
  );
  const reconciliationDiagnostic =
    reconciled.code === 0
      ? ""
      : await (
          await fetch(
            `http://127.0.0.1:${ingestionPort}/v1/ingestion-runs/` +
              collectedRun.id,
            {
              headers: {
                authorization: `Bearer ${administrationKey}`,
                "cf-connecting-ip": "203.0.113.28",
              },
            },
          )
        ).text();
  assert.equal(
    reconciled.code,
    0,
    `${reconciled.stdout}\n${reconciled.stderr}\n` +
      `${reconciliationDiagnostic}\n${ingestion.getOutput()}`,
  );
  const reconciliation = JSON.parse(reconciled.stdout);
  assert.equal(reconciliation.cards.length, 1);
  assert.equal(reconciliation.printings.length, 1);
  assert.equal(reconciliation.products.length, 2);
  assert.ok(
    reconciliation.warnings.some(
      ({ code, path, raw_value }) =>
        code === "unknown_source_field" &&
        path === "source_sidecar.raw.products[0].campaign_note" &&
        raw_value === "Optional Official Source marketing copy",
    ),
  );
  const printingId = reconciliation.printings[0].id;
  const productOnly = reconciliation.products.find(
    ({ official_code }) => official_code === "BT-PRODUCT-ONLY",
  );
  const cardBearing = reconciliation.products.find(
    ({ official_code }) => official_code === "BT-CARD-BEARING",
  );
  assert.ok(productOnly);
  assert.ok(cardBearing);
  const productId = productOnly.id;
  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", collectedRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const inspection = JSON.parse(inspected.stdout);
  assert.equal(inspection.run_id, collectedRun.id);
  assert.equal(inspection.diff.summary.cards_added, 1);
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      collectedRun.id,
      "--candidate-digest",
      inspection.candidate_digest,
      "--expected-current-revision",
      "catrev_spine_000",
      "--idempotency-key",
      "acceptance-product-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  if (approved.code !== 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  assert.equal(
    approved.code,
    0,
    `${approved.stdout}\n${approved.stderr}\n${ingestion.getOutput()}`,
  );
  const published = JSON.parse(approved.stdout);
  let revisionId = published.resulting_revision_id;
  assert.match(revisionId, /^catrev_/u);

  const multiCollected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      multiPlanPath,
      "--idempotency-key",
      "acceptance-product-multi-plan",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    multiCollected.code,
    0,
    `${multiCollected.stdout}\n${multiCollected.stderr}\n${ingestion.getOutput()}`,
  );
  const multiRun = JSON.parse(multiCollected.stdout);
  const multiShownResult = await runCli(
    ["source", "show", "--run-id", multiRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(multiShownResult.code, 0, multiShownResult.stderr);
  const multiShown = JSON.parse(multiShownResult.stdout);
  assert.deepEqual(
    multiShown.evidence_plans.map(
      ({ supported_game, source_lineage, adapter_version, requests }) => ({
        supported_game,
        source_lineage,
        adapter_version,
        request_ids: requests.map(({ id }) => id),
      }),
    ),
    [
      {
        supported_game: "digimon",
        source_lineage: "digimon-en",
        adapter_version: "digimon-en@1",
        request_ids: officialPlan(
          "digimon",
          "digimon-en",
          "digimon-en@1",
        ).requests.map(({ id }) => id),
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "one-piece-json-document@2",
        request_ids: officialPlan(
          "one-piece",
          "one-piece-en",
          "one-piece-json-document@2",
        ).requests.map(({ id }) => id),
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fusion-world-en@1",
        request_ids: officialPlan(
          "fusion-world",
          "fusion-world-en",
          "fusion-world-en@1",
        ).requests.map(({ id }) => id),
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-asia",
        adapter_version: "gundam-en-asia@1",
        request_ids: officialPlan(
          "gundam",
          "gundam-en-asia",
          "gundam-en-asia@1",
        ).requests.map(({ id }) => id),
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-us",
        adapter_version: "gundam-en-us@1",
        request_ids: officialPlan(
          "gundam",
          "gundam-en-us",
          "gundam-en-us@1",
        ).requests.map(({ id }) => id),
      },
    ],
  );
  for (const scalar of [
    "supported_game",
    "game_profile_version",
    "source_lineage",
    "adapter_version",
  ]) {
    assert.equal(Object.hasOwn(multiShown, scalar), false);
  }
  const multiResumed = await runCli(
    ["source", "resume", "--run-id", multiRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(multiResumed.code, 0, multiResumed.stderr);
  await waitForRunState(
    multiRun.id,
    "parsing",
    cliEnvironment,
    ingestion,
  );
  const multiReconciled = await runCli(
    ["run", "reconcile", "--run-id", multiRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(
    multiReconciled.code,
    0,
    `${multiReconciled.stdout}\n${multiReconciled.stderr}\n${ingestion.getOutput()}`,
  );
  const multiInspectionResult = await runCli(
    ["candidate", "inspect", "--run-id", multiRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(
    multiInspectionResult.code,
    0,
    `${multiInspectionResult.stdout}\n${multiInspectionResult.stderr}\n` +
      ingestion.getOutput(),
  );
  const multiInspection = JSON.parse(multiInspectionResult.stdout);
  assert.equal(multiInspection.expected_current_revision_id, revisionId);
  const multiApproved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      multiRun.id,
      "--candidate-digest",
      multiInspection.candidate_digest,
      "--expected-current-revision",
      revisionId,
      "--idempotency-key",
      "acceptance-product-multi-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    multiApproved.code,
    0,
    `${multiApproved.stdout}\n${multiApproved.stderr}\n${ingestion.getOutput()}`,
  );
  const multiPublished = JSON.parse(multiApproved.stdout);
  assert.notEqual(multiPublished.resulting_revision_id, revisionId);
  const allFiveRevisionId = multiPublished.resulting_revision_id;
  revisionId = allFiveRevisionId;

  const carryCollected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      carryPlanPath,
      "--idempotency-key",
      "acceptance-product-carry-collect",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(carryCollected.code, 0, carryCollected.stderr);
  const carryRun = JSON.parse(carryCollected.stdout);
  assert.equal(
    (
      await runCli(
        ["source", "resume", "--run-id", carryRun.id, "--json"],
        cliEnvironment,
      )
    ).code,
    0,
  );
  await waitForRunState(carryRun.id, "parsing", cliEnvironment, ingestion);
  assert.equal(
    (
      await runCli(
        ["run", "reconcile", "--run-id", carryRun.id, "--json"],
        cliEnvironment,
      )
    ).code,
    0,
  );
  const carryInspectionResult = await runCli(
    ["candidate", "inspect", "--run-id", carryRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(carryInspectionResult.code, 0, carryInspectionResult.stderr);
  const carryInspection = JSON.parse(carryInspectionResult.stdout);
  const carryApproved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      carryRun.id,
      "--candidate-digest",
      carryInspection.candidate_digest,
      "--expected-current-revision",
      allFiveRevisionId,
      "--idempotency-key",
      "acceptance-product-carry-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    carryApproved.code,
    0,
    `${carryApproved.stdout}\n${carryApproved.stderr}\n` +
      ingestion.getOutput(),
  );
  revisionId = JSON.parse(carryApproved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 23_231,
    port: apiPort,
    statePath,
  });
  t.after(() => stopWorker(api));
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    api,
  );
  const headers = { authorization: `Bearer ${apiKey}` };
  const catalogueResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/catalogue`,
    { headers },
  );
  assert.equal(catalogueResponse.status, 200);
  const catalogueDocument = await catalogueResponse.json();
  const successfulChecks =
    catalogueDocument.data.last_successful_checks;
  assert.deepEqual(
    successfulChecks.map(({ game, area }) => `${game}:${area}`),
    [
      "digimon:cards-and-printings",
      "digimon:products-and-releases",
      "fusion-world:cards-and-printings",
      "fusion-world:products-and-releases",
      "gundam:cards-and-printings",
      "gundam:products-and-releases",
      "one-piece:cards-and-printings",
      "one-piece:products-and-releases",
    ],
  );
  assert.ok(
    successfulChecks.every(({ checked_at }) =>
      Number.isFinite(Date.parse(checked_at))
    ),
  );
  const productResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/products/${productId}?include=evidence`,
    { headers },
  );
  assert.equal(productResponse.status, 200);
  const productDocument = await productResponse.json();
  const apiSchema = JSON.parse(
    await readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/schemas/api.schema.json",
      ),
      "utf8",
    ),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validateProduct = ajv.compile({
    ...apiSchema,
    $ref: "#/$defs/ProductDocument",
  });
  assert.equal(
    validateProduct(productDocument),
    true,
    ajv.errorsText(validateProduct.errors),
  );
  assert.equal(productDocument.data.releases[0].region, "unknown");
  assert.equal(productDocument.data.releases[0].status, "announced");
  assert.equal(
    productDocument.data.lifecycle.last_observed_revision_id,
    allFiveRevisionId,
  );
  assert.match(
    productDocument.provenance["/data/official_code"][0],
    /^srcobs_/u,
  );
  const printingResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/printings/${printingId}`,
    { headers },
  );
  assert.equal(printingResponse.status, 200);
  const printingDocument = await printingResponse.json();
  assert.equal(
    printingDocument.data.lifecycle.last_observed_revision_id,
    allFiveRevisionId,
  );
  assert.equal(printingDocument.data.products.length, 1);
  assert.deepEqual(
    {
      id: printingDocument.data.products[0].id,
      evidence_category:
        printingDocument.data.products[0].evidence_category,
      source_lineage:
        printingDocument.data.products[0].source_lineage,
    },
    {
      id: cardBearing.id,
      evidence_category: "explicit",
      source_lineage: "digimon-en",
    },
  );
  assert.equal(
    printingDocument.data.products[0].source_observation_ids.length,
    1,
  );
  assert.match(
    printingDocument.data.products[0].source_observation_ids[0],
    /^srcobs_/u,
  );
  assert.equal(printingDocument.data.distribution_contexts.length, 1);
  assert.deepEqual(
    {
      kind: printingDocument.data.distribution_contexts[0].kind,
      product_id:
        printingDocument.data.distribution_contexts[0].product_id,
      evidence_category:
        printingDocument.data.distribution_contexts[0].evidence_category,
      source_lineage:
        printingDocument.data.distribution_contexts[0].source_lineage,
    },
    {
      kind: "tournament_pack",
      product_id: cardBearing.id,
      evidence_category: "derived",
      source_lineage: "digimon-en",
    },
  );
  assert.equal(
    printingDocument.data.distribution_contexts[0]
      .source_observation_ids.length,
    1,
  );

  const [products, releases, contexts, relationships, cards, printings] =
    await Promise.all(
    [
      "products",
      "releases",
      "distribution-contexts",
      "relationships",
      "cards",
      "printings",
    ].map((component) =>
      exportRecords(apiPort, apiKey, revisionId, component),
    ),
  );
  const exportSchema = JSON.parse(
    await readFile(
      resolve(
        root,
        "prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json",
      ),
      "utf8",
    ),
  );
  const validatePrintingExport = ajv.compile({
    ...exportSchema,
    $ref: "#/$defs/PrintingRecord",
  });
  for (const printing of printings) {
    assert.equal(
      validatePrintingExport(printing),
      true,
      ajv.errorsText(validatePrintingExport.errors),
    );
  }
  assert.equal(
    cards.find(
      ({ official_identity }) =>
        official_identity?.value === "BT99-001",
    ).lifecycle.last_observed_revision_id,
    allFiveRevisionId,
  );
  assert.equal(
    printings.find(({ id }) => id === printingId)
      .lifecycle.last_observed_revision_id,
    allFiveRevisionId,
  );
  assert.equal(
    products.find(({ official_code }) => official_code === "OP-RAW-01")
      .lifecycle.last_observed_revision_id,
    revisionId,
  );
  assert.equal(products.length, 5);
  assert.equal(releases.length, 5);
  assert.equal(contexts.length, 5);
  assert.ok(products.some(({ id }) => id === productId));
  assert.ok(products.every(({ releases: value }) => value === undefined));
  assert.ok(
    releases.some(
      (release) =>
        release.product_id === productId &&
        release.region === "unknown",
    ),
  );
  assert.ok(contexts.some((context) => context.product_id === productId));
  assert.equal(cards.length, 4);
  assert.ok(
    relationships.some(
      ({ kind, evidence_category }) =>
        kind === "distribution-context-product" &&
        evidence_category === "explicit",
    ),
  );
  for (const projection of [
    ...printingDocument.data.products,
    ...printingDocument.data.distribution_contexts,
  ]) {
    assert.ok(
      relationships.some(
        (relationship) =>
          relationship.from.id === printingId &&
          relationship.to.id === projection.id &&
          relationship.evidence_category ===
            projection.evidence_category &&
          relationship.source_lineage === projection.source_lineage &&
          JSON.stringify(relationship.source_observation_ids) ===
            JSON.stringify(projection.source_observation_ids),
      ),
    );
  }
  for (const code of [
    "OP-RAW-01",
    "FB-RAW-01",
    "GD-RAW-01",
  ]) {
    assert.ok(products.some(({ official_code }) => official_code === code));
  }
  const gundam = products.find(
    ({ official_code }) => official_code === "GD-RAW-01",
  );
  assert.ok(gundam);
  const gundamCard = cards.find(
    ({ official_identity }) => official_identity?.value === "GD99-001",
  );
  assert.deepEqual(gundamCard.source_lineages, [
    "gundam-en-asia",
    "gundam-en-us",
  ]);
  const gundamPrinting = printings.find(
    ({ card_id }) => card_id === gundamCard.id,
  );
  assert.deepEqual(gundamPrinting.source_lineages, [
    "gundam-en-asia",
    "gundam-en-us",
  ]);
  const gundamPrintingResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/printings/${gundamPrinting.id}?include=evidence`,
    { headers },
  );
  assert.equal(gundamPrintingResponse.status, 200);
  const gundamPrintingDocument = await gundamPrintingResponse.json();
  assert.deepEqual(gundamPrintingDocument.data.source_lineages, [
    "gundam-en-asia",
    "gundam-en-us",
  ]);
  assert.deepEqual(
    gundamPrintingDocument.included.map(({ source }) => source).sort(),
    ["gundam-en-asia", "gundam-en-us"],
  );
  assert.deepEqual(
    releases
      .filter(({ product_id }) => product_id === gundam.id)
      .map(({ region }) => region)
      .sort(),
    ["EN-ASIA", "EN-US"],
  );
  assert.ok(
    relationships.some(
      ({ kind, from, to }) =>
        kind === "product-card" &&
        from.id === cardBearing.id &&
        cards.some(({ id }) => id === to.id),
    ),
  );
});

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

async function applyMigrations(statePath) {
  const result = await runProcess(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "CATALOGUE_DB",
      "--local",
      "--config",
      "apps/ingestion/wrangler.jsonc",
      "--persist-to",
      statePath,
    ],
    {
      ...processEnvironment(statePath),
      CI: "1",
    },
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

function startWorker({ config, envFile, inspectorPort, port, statePath }) {
  let output = "";
  const child = spawn(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "dev",
      "--config",
      config,
      ...(envFile === undefined ? [] : ["--env-file", envFile]),
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--persist-to",
      statePath,
      "--log-level",
      "error",
      "--show-interactive-dev-session",
      "false",
    ],
    {
      cwd: root,
      env: processEnvironment(statePath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return { process: child, getOutput: () => output };
}

async function waitForRunState(
  runId,
  expectedState,
  environment,
  worker,
) {
  const deadline = Date.now() + 20_000;
  let lastDocument = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      lastDocument = document;
      if (document.state === expectedState) return document;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Run did not reach ${expectedState}: ${JSON.stringify(lastDocument)}\n` +
      worker.getOutput(),
  );
}

async function waitForHealth(url, key, worker) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) throw new Error(worker.getOutput());
    try {
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (response.ok) return;
    } catch {
      // The local Worker has not started accepting requests yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Worker did not become healthy\n${worker.getOutput()}`);
}

async function stopWorker(worker) {
  if (worker.process.exitCode !== null) return;
  worker.process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => worker.process.once("exit", resolveExit)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000)),
  ]);
  if (worker.process.exitCode === null) worker.process.kill("SIGKILL");
}

function runCli(arguments_, environment) {
  return runProcess(
    process.execPath,
    [resolve(root, "cli/keepr.mjs"), ...arguments_],
    {
      ...process.env,
      ...environment,
    },
  );
}

function runProcess(command, arguments_, environment) {
  return new Promise((resolveExit) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
  });
}

function processEnvironment(statePath) {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return {
    ...environment,
    WRANGLER_LOG_PATH: join(statePath, "logs"),
  };
}

const officialSurfaces = {
  "one-piece-en": [
    "card-list",
    "products",
    "releases",
    "restrictions",
    "block-policy",
    "errata",
    "don-rules",
  ],
  "fusion-world-en": [
    "card-search",
    "products",
    "releases",
    "legality-current",
    "legality-history",
    "errata",
  ],
  "digimon-en": [
    "card-list",
    "products",
    "releases",
    "restrictions-current",
    "restrictions-history",
    "errata",
  ],
  "gundam-en-asia": [
    "packages",
    "products",
    "releases",
    "legality",
    "errata",
  ],
  "gundam-en-us": [
    "packages",
    "products",
    "releases",
    "legality",
    "errata",
  ],
};

const officialUrls = {
  "one-piece-en": {
    "card-list": "https://en.onepiece-cardgame.com/cardlist/",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    restrictions:
      "https://en.onepiece-cardgame.com/rules/restriction/",
    "block-policy":
      "https://en.onepiece-cardgame.com/rules/block_icon/",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
    "don-rules": "https://en.onepiece-cardgame.com/rules/",
  },
  "fusion-world-en": {
    "card-search": "https://www.dbs-cardgame.com/fw/en/cardlist/",
    products: "https://www.dbs-cardgame.com/fw/en/products/",
    releases: "https://www.dbs-cardgame.com/fw/en/products/",
    "legality-current":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    "legality-history":
      "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    errata: "https://www.dbs-cardgame.com/fw/en/rules/errata-card/",
  },
  "digimon-en": {
    "card-list":
      "https://world.digimoncard.com/cards/index.php?search=true",
    products: "https://world.digimoncard.com/products/",
    releases: "https://world.digimoncard.com/products/",
    "restrictions-current":
      "https://world.digimoncard.com/rule/restriction_card/",
    "restrictions-history":
      "https://world.digimoncard.com/rule/restriction_card/",
    errata: "https://world.digimoncard.com/rule/errata_card/",
  },
  "gundam-en-asia": {
    packages: "https://www.gundam-gcg.com/asia-en/cards/index.php",
    products: "https://www.gundam-gcg.com/asia-en/products/list.php",
    releases: "https://www.gundam-gcg.com/asia-en/products/list.php",
    legality: "https://www.gundam-gcg.com/asia-en/rules/",
    errata:
      "https://www.gundam-gcg.com/asia-en/news/?subcategory=rules",
  },
  "gundam-en-us": {
    packages: "https://www.gundam-gcg.com/en/cards/index.php",
    products: "https://www.gundam-gcg.com/en/products/list.php",
    releases: "https://www.gundam-gcg.com/en/products/list.php",
    legality: "https://www.gundam-gcg.com/en/rules/",
    errata: "https://www.gundam-gcg.com/en/news/?subcategory=rules",
  },
};

function officialPlan(game, lineage, adapter) {
  return {
    supported_game: game,
    source_lineage: lineage,
    adapter_version: adapter,
    requests: officialSurfaces[lineage].map((surface) => ({
      id: `${lineage}:${surface}`,
      url: officialUrls[lineage][surface],
      headers: { accept: "text/html" },
    })),
  };
}
