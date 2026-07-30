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
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(
    await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
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
      "--game",
      "digimon",
      "--lineage",
      "digimon-en",
      "--adapter",
      "digimon-en@1",
      "--request-id",
      "products-and-releases",
      "--url",
      "https://synthetic-source.invalid/catalogue-discovery",
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
  assert.equal(
    reconciled.code,
    0,
    `${reconciled.stdout}\n${reconciled.stderr}\n${ingestion.getOutput()}`,
  );
  const reconciliation = JSON.parse(reconciled.stdout);
  assert.equal(reconciliation.cards.length, 1);
  assert.equal(reconciliation.printings.length, 0);
  assert.equal(reconciliation.products.length, 2);
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
  const revisionId = published.resulting_revision_id;
  assert.match(revisionId, /^catrev_/u);
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
  const capturedAt =
    catalogueDocument.data.last_successful_checks[0].checked_at;
  assert.deepEqual(catalogueDocument.data.last_successful_checks, [
    {
      game: "digimon",
      area: "cards-and-printings",
      checked_at: capturedAt,
    },
    {
      game: "digimon",
      area: "products-and-releases",
      checked_at: capturedAt,
    },
  ]);
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
  assert.match(
    productDocument.provenance["/data/official_code"][0],
    /^srcobs_/u,
  );

  const [products, releases, contexts, relationships, cards] = await Promise.all(
    [
      "products",
      "releases",
      "distribution-contexts",
      "relationships",
      "cards",
    ].map((component) =>
      exportRecords(apiPort, apiKey, revisionId, component),
    ),
  );
  assert.equal(products.length, 2);
  assert.equal(releases.length, 1);
  assert.equal(contexts.length, 1);
  assert.ok(products.some(({ id }) => id === productId));
  assert.ok(products.every(({ releases: value }) => value === undefined));
  assert.equal(releases[0].product_id, productId);
  assert.equal(releases[0].region, "unknown");
  assert.equal(contexts[0].product_id, productId);
  assert.equal(cards.length, 1);
  assert.equal(relationships.length, 2);
  assert.ok(
    relationships.some(
      ({ kind, evidence_category }) =>
        kind === "distribution-context-product" &&
        evidence_category === "explicit",
    ),
  );
  assert.ok(
    relationships.some(
      ({ kind, from, to }) =>
        kind === "product-card" &&
        from.id === cardBearing.id &&
        to.id === cards[0].id,
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
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      if (document.state === expectedState) return document;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Run did not reach ${expectedState}\n${worker.getOutput()}`,
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
