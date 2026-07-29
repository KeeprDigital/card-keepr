import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const apiPort = 20_787;
const ingestionPort = 20_788;
const schemasDirectory = resolve(
  root,
  "prototype/formalize-implementation-contracts/schemas",
);
const apiSchema = readSchema("api.schema.json");
const manifestSchema = readSchema("catalogue-export-manifest.schema.json");
const recordSchema = readSchema("catalogue-export-record.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(
  manifestSchema,
  "https://card-keepr.invalid/schemas/catalogue-export-manifest.schema.json",
);
ajv.addSchema(recordSchema);
ajv.addSchema(apiSchema);

const validateCatalogue = schemaValidator(apiSchema, "CatalogueDocument");
const validateCard = schemaValidator(apiSchema, "CardDocument");
const validatePrinting = schemaValidator(apiSchema, "PrintingDocument");
const validateExport = schemaValidator(apiSchema, "CatalogueExportDocument");
const validateExportRecord = ajv.getSchema(recordSchema.$id);

test("the owner publishes the first fixture Catalogue Revision through the black-box seam", async (t) => {
  const testDirectory = await mkdtemp(
    join(tmpdir(), "card-keepr-publication-"),
  );
  const statePath = join(testDirectory, "shared-state");
  const apiKey = randomUUID();
  const administrationKey = randomUUID();
  const apiEnv = join(testDirectory, "api.env");
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await Promise.all([
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, {
      mode: 0o600,
    }),
  ]);
  await applyMigrations(statePath);

  const workers = [];
  t.after(async () => {
    await Promise.all(workers.map((worker) => stopWorker(worker)));
  });

  let api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 21_229,
    port: apiPort,
    statePath,
  });
  workers.push(api);
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    api,
  );
  const baselineResponse = await apiFetch("/v1/catalogue", apiKey);
  const baseline = await baselineResponse.json();
  assert.equal(baselineResponse.status, 200);
  assertSchema(validateCatalogue, baseline);
  const expectedCurrentRevision = baseline.data.current_revision_id;
  await stopWorker(api);

  let ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 21_230,
    port: ingestionPort,
    statePath,
  });
  workers.push(ingestion);
  await waitForHealth(
    `http://127.0.0.1:${ingestionPort}/health`,
    administrationKey,
    ingestion,
  );

  const cliEnvironment = {
    KEEPR_API_URL: `http://127.0.0.1:${apiPort}`,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    KEEPR_API_KEY: apiKey,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const start = await runCli(
    [
      "run",
      "start",
      "--fixture",
      "first-catalogue",
      "--games",
      "one-piece",
      "--idempotency-key",
      "ingestion_fixture_first_001",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(start.code, 0, start.stderr);
  const startedRun = JSON.parse(start.stdout);
  assert.equal(startedRun.state, "awaiting_approval");
  assert.equal(startedRun.expected_current_revision_id, expectedCurrentRevision);
  assert.match(startedRun.id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.match(startedRun.candidate_digest, /^[a-f0-9]{64}$/);

  const shown = await runCli(
    ["run", "show", "--run-id", startedRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), startedRun);

  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", startedRun.id, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.run_id, startedRun.id);
  assert.equal(candidate.candidate_digest, startedRun.candidate_digest);
  assert.deepEqual(candidate.diff.summary, {
    cards_added: 1,
    printings_added: 1,
    warnings: 0,
  });
  assert.notEqual(candidate.diff.cards.added[0], candidate.diff.printings.added[0]);
  const cardId = candidate.diff.cards.added[0];
  const printingId = candidate.diff.printings.added[0];

  const staleApproval = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      startedRun.id,
      "--candidate-digest",
      "0".repeat(64),
      "--expected-current-revision",
      expectedCurrentRevision,
      "--idempotency-key",
      "approval_fixture_first_stale_001",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(staleApproval.code, 7, staleApproval.stderr);
  assert.deepEqual(JSON.parse(staleApproval.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "candidate_digest_mismatch",
    detail: "The candidate digest no longer matches the requested approval.",
  });
  await stopWorker(ingestion);

  api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 21_231,
    port: apiPort,
    statePath,
  });
  workers.push(api);
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    api,
  );
  const [candidateStatus, candidateCard] = await Promise.all([
    apiFetch("/v1/catalogue", apiKey),
    apiFetch(`/v1/cards/${cardId}`, apiKey),
  ]);
  assert.equal(candidateStatus.status, 200);
  assert.equal(
    (await candidateStatus.json()).data.current_revision_id,
    expectedCurrentRevision,
  );
  assert.equal(candidateCard.status, 404);
  const stillUnpublished = await apiFetch(`/v1/cards/${cardId}`, apiKey);
  assert.equal(stillUnpublished.status, 404);
  await stopWorker(api);

  ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 21_232,
    port: ingestionPort,
    statePath,
  });
  workers.push(ingestion);
  await waitForHealth(
    `http://127.0.0.1:${ingestionPort}/health`,
    administrationKey,
    ingestion,
  );

  const approval = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      startedRun.id,
      "--candidate-digest",
      startedRun.candidate_digest,
      "--expected-current-revision",
      expectedCurrentRevision,
      "--idempotency-key",
      "approval_fixture_first_001",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(approval.code, 0, approval.stderr);
  const publishedRun = JSON.parse(approval.stdout);
  assert.equal(publishedRun.id, startedRun.id);
  assert.equal(publishedRun.state, "published");
  assert.match(publishedRun.published_revision_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.match(publishedRun.export_manifest_digest, /^[a-f0-9]{64}$/);
  await stopWorker(ingestion);

  api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 21_233,
    port: apiPort,
    statePath,
  });
  workers.push(api);
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    api,
  );

  const revisionId = publishedRun.published_revision_id;
  const [catalogueResponse, cardResponse, printingResponse, exportResponse] =
    await Promise.all([
      apiFetch("/v1/catalogue", apiKey),
      apiFetch(`/v1/cards/${cardId}`, apiKey),
      apiFetch(`/v1/printings/${printingId}`, apiKey),
      apiFetch(`/v1/catalogue-exports/${revisionId}`, apiKey),
    ]);
  const [catalogue, card, printing, catalogueExport] = await Promise.all([
    catalogueResponse.json(),
    cardResponse.json(),
    printingResponse.json(),
    exportResponse.json(),
  ]);

  assert.equal(catalogueResponse.status, 200);
  assert.equal(cardResponse.status, 200);
  assert.equal(printingResponse.status, 200);
  assert.equal(exportResponse.status, 200);
  assertSchema(validateCatalogue, catalogue);
  assertSchema(validateCard, card);
  assertSchema(validatePrinting, printing);
  assertSchema(validateExport, catalogueExport);
  assert.equal(catalogue.data.current_revision_id, revisionId);
  assert.equal(card.data.id, cardId);
  assert.deepEqual(card.data.printing_ids, [printingId]);
  assert.equal(printing.data.id, printingId);
  assert.equal(printing.data.card_id, cardId);
  assert.equal(catalogueExport.data.catalogue_revision.id, revisionId);
  assert.equal(
    catalogueExport.data.manifest_sha256,
    publishedRun.export_manifest_digest,
  );

  for (const [response, document] of [
    [catalogueResponse, catalogue],
    [cardResponse, card],
    [printingResponse, printing],
    [exportResponse, catalogueExport],
  ]) {
    assert.equal(response.headers.get("x-catalogue-revision"), revisionId);
    assert.equal(document.meta.catalogue_revision_id, revisionId);
  }

  assert.equal(
    manifestDigest(catalogueExport.data),
    catalogueExport.data.manifest_sha256,
  );
  for (const component of catalogueExport.data.components) {
    const response = await apiFetch(component.content_url, apiKey);
    assert.equal(response.status, 200, component.name);
    const compressed = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(compressed), component.compressed_sha256);
    assert.equal(compressed.byteLength, component.compressed_bytes);
    assert.deepEqual(Array.from(compressed.slice(0, 10)), [
      0x1f,
      0x8b,
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x02,
      0xff,
    ]);
    const uncompressed = gunzipSync(compressed);
    assert.equal(sha256(uncompressed), component.content_sha256);
    assert.equal(uncompressed.byteLength, component.uncompressed_bytes);
    const records = parseNdjson(uncompressed);
    assert.equal(records.length, component.records);
    for (const record of records) assertSchema(validateExportRecord, record);
  }
});

function readSchema(name) {
  return JSON.parse(readFileSync(resolve(schemasDirectory, name), "utf8"));
}

function schemaValidator(schema, definition) {
  return ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
}

function assertSchema(validate, value) {
  assert.equal(validate?.(value), true, JSON.stringify(validate?.errors));
}

function apiFetch(path, key) {
  return fetch(`http://127.0.0.1:${apiPort}${path}`, {
    headers: { authorization: `Bearer ${key}` },
  });
}

function applyMigrations(statePath) {
  return runProcess(
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
      ...processEnvWithoutSecrets(),
      CI: "1",
      WRANGLER_LOG_PATH: join(statePath, "logs"),
    },
  ).then((result) => {
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });
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
      env: {
        ...processEnvWithoutSecrets(),
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
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
    if (worker.process.exitCode !== null) {
      throw new Error(worker.getOutput());
    }
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
      ...processEnvWithoutSecrets(),
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

function processEnvWithoutSecrets() {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return environment;
}

function parseNdjson(bytes) {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return [];
  assert.ok(text.endsWith("\n"));
  return text
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function manifestDigest(manifest) {
  return sha256(
    `${canonicalJson({
      ...manifest,
      manifest_sha256: "0".repeat(64),
    })}\n`,
  );
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
