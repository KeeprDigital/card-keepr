import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

test("the CLI publishes separated Product catalogue data consumed through authenticated HTTP", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-product-boundary-"),
  );
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);
  await applyMigrations(statePath);
  const seeded = await seedProductCandidate(directory, statePath);

  const ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 23_230,
    port: ingestionPort,
    statePath,
  });
  t.after(async () => {
    await stopWorker(ingestion);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(
    `http://127.0.0.1:${ingestionPort}/health`,
    administrationKey,
    ingestion,
  );
  const cliEnvironment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", seeded.runId, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const inspection = JSON.parse(inspected.stdout);
  assert.equal(inspection.run_id, seeded.runId);
  assert.equal(inspection.candidate_digest, seeded.candidateDigest);
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      seeded.runId,
      "--candidate-digest",
      seeded.candidateDigest,
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
  const productResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/products/${seeded.productId}?include=evidence`,
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
  assert.deepEqual(productDocument.provenance["/data/official_code"], [
    "srcobs_acceptance_product",
  ]);

  const [products, releases, contexts] = await Promise.all(
    ["products", "releases", "distribution-contexts"].map((component) =>
      exportRecords(apiPort, apiKey, revisionId, component),
    ),
  );
  assert.equal(products.length, 1);
  assert.equal(releases.length, 1);
  assert.equal(contexts.length, 1);
  assert.equal(products[0].id, seeded.productId);
  assert.equal(products[0].releases, undefined);
  assert.equal(releases[0].product_id, seeded.productId);
  assert.equal(releases[0].region, "unknown");
  assert.equal(contexts[0].product_id, seeded.productId);
});

async function seedProductCandidate(directory, statePath) {
  const runId = "run_acceptance_product";
  const productId = "product_acceptance_unknown";
  const candidate = {
    fixture: "first-catalogue",
    selected_games: ["digimon"],
    cards: [],
    printings: [],
    products: [
      {
        reference: { kind: "official_code", value: "BT-UNKNOWN" },
        id: productId,
        game: "digimon",
        official_code: "BT-UNKNOWN",
        name: "Unknown-region Product",
        releases: [
          {
            id: "release_acceptance_unknown",
            product_id: productId,
            region: "unknown",
            date: { precision: "unknown", value: null },
            status: "announced",
          },
        ],
        observed: true,
        withdrawal: null,
        included: [
          {
            type: "source_observation",
            id: "srcobs_acceptance_product",
            captured_at: "2026-07-30T01:02:03.000Z",
            source: "digimon-en",
          },
        ],
        provenance: {
          "/data/official_code": ["srcobs_acceptance_product"],
          "/data/name": ["srcobs_acceptance_product"],
          "/data/releases/0/date/precision": [
            "srcobs_acceptance_product",
          ],
          "/data/releases/0/date/value": ["srcobs_acceptance_product"],
          "/data/releases/0/status": ["srcobs_acceptance_product"],
        },
        disagreements: [],
      },
    ],
    distribution_contexts: [
      {
        id: "distribution_context_acceptance",
        game: "digimon",
        key: "acceptance-promotion",
        kind: "promotion",
        label: "Acceptance promotion",
        product_id: productId,
        evidence_category: "explicit",
        observed: true,
      },
    ],
    product_relationships: [],
    product_observed_games: ["digimon"],
  };
  const candidateDigest = sha256(canonicalJson(candidate));
  const sqlPath = join(directory, "seed-product.sql");
  await writeFile(
    sqlPath,
    `INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key,
       candidate_digest, candidate_catalogue_digest,
       candidate_created_at, approval_deadline, candidate_json,
       progress_json, warnings_json, approval_history_json
     ) VALUES (
       '${runId}', 'awaiting_approval', '["digimon"]',
       '2026-07-30T01:02:03.000Z', 'catrev_spine_000',
       'acceptance-product-seed', '${candidateDigest}', '${candidateDigest}',
       '2026-07-30T01:02:03.000Z', '2026-08-06T01:02:03.000Z',
       '${sqlText(JSON.stringify(candidate))}',
       '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}',
       '[]', '[]'
     );
     UPDATE operation_state
     SET active_ingestion_run_id = '${runId}'
     WHERE singleton = 1;`,
  );
  const seeded = await runProcess(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "execute",
      "CATALOGUE_DB",
      "--local",
      "--config",
      "apps/ingestion/wrangler.jsonc",
      "--persist-to",
      statePath,
      "--file",
      sqlPath,
    ],
    processEnvironment(statePath),
  );
  assert.equal(seeded.code, 0, seeded.stderr || seeded.stdout);
  return { runId, productId, candidateDigest };
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
      "--env-file",
      envFile,
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

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort(compareUtf8)
      .map(
        (key) =>
          `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return typeof value === "string"
    ? JSON.stringify(value.normalize("NFC"))
    : JSON.stringify(value);
}

function compareUtf8(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sqlText(value) {
  return value.replaceAll("'", "''");
}
