import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  administrationPollInterval,
  runCli,
  startWorker,
  stopWorker,
  waitForResponse,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

const root = resolve(import.meta.dirname, "..");
const apiSchema = JSON.parse(
  readFileSync(resolve(root, "prototype/formalize-implementation-contracts/schemas/api.schema.json"), "utf8"),
);
const exportManifestSchemaV5 = JSON.parse(
  readFileSync(
    resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v5.schema.json"),
    "utf8",
  ),
);
const exportRecordSchemaV5 = JSON.parse(
  readFileSync(
    resolve(root, "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v5.schema.json"),
    "utf8",
  ),
);
const _gzipGolden = JSON.parse(
  readFileSync(resolve(root, "acceptance/fixtures/catalogue-export-gzip-golden.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(exportManifestSchemaV5);
ajv.addSchema(apiSchema);
ajv.addSchema(exportRecordSchemaV5);
const _validateLegalityStatus = ajv.getSchema(`${apiSchema.$id}#/$defs/LegalityStatusDocument`);
const _validateProblem = ajv.getSchema(`${apiSchema.$id}#/$defs/Problem`);
const _validateLegalityRuleExport = ajv.getSchema(`${exportRecordSchemaV5.$id}#/$defs/LegalityRuleRecord`);
const _validateCatalogueExportDocument = ajv.getSchema(`${apiSchema.$id}#/$defs/CatalogueExportDocument`);

test("the public CLI fails closed for incomplete production source plans", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-contextual-legality-fail-closed-"));
  const administrationKey = crypto.randomUUID();
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "fail-closed-ingestion");
  const ingestionEnv = join(directory, "fail-closed-ingestion.env");
  await writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    statePath: join(directory, "state"),
  });
  t.after(async () => {
    await stopWorker(ingestion);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForResponse(`${ingestion.url}/health`, ingestion, "fail-closed ingestion Worker", {
    authorization: `Bearer ${administrationKey}`,
  });
  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "gundam",
      "--lineage",
      "gundam-en-asia",
      "--adapter",
      "gundam-en-asia@7",
      "--request-id",
      "discovery",
      "--url",
      "https://www.gundam-gcg.com/asia-en/contextual-legality",
      "--idempotency-key",
      "acceptance-undemonstrated-json",
      "--json",
    ],
    {
      KEEPR_ADMINISTRATION_KEY: administrationKey,
      KEEPR_INGESTION_URL: ingestion.url,
    },
  );
  assert.equal(result.code, 8, result.stderr);
  assert.equal(JSON.parse(result.stdout).code, "incomplete_source_plan");
});

test("fixture-backed DON!! ingestion reaches the authenticated consumer boundary", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-don-legality-"));
  const statePath = join(directory, "state");
  const administrationKey = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const sourceServiceName = `card-keepr-don-source-${process.pid}`;
  const sourceConfig = await localConfig(
    "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    directory,
    "don-source",
    { name: sourceServiceName },
  );
  const ingestionConfig = await localConfig("apps/ingestion/wrangler.jsonc", directory, "don-ingestion", {
    main: resolve(root, "acceptance/fixtures/contextual-legality-ingestion-harness.ts"),
    services: [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: sourceServiceName,
      },
    ],
  });
  const apiConfig = await localConfig("apps/api/wrangler.jsonc", directory, "don-api", {
    main: resolve(root, "test/support/api-worker.ts"),
  });
  const ingestionEnv = join(directory, "don-ingestion.env");
  const apiEnv = join(directory, "don-api.env");
  await Promise.all([
    writeFile(ingestionEnv, `ADMINISTRATION_KEY=${administrationKey}\n`, { mode: 0o600 }),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
  ]);
  const source = await startWorker({
    config: sourceConfig,
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    migrate: true,
    testMigrations: await syntheticSourceAdapterMigrations(),
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion), api === null ? Promise.resolve() : stopWorker(api)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(`${source.url}/don-legality`, source, "test-owned DON source"),
    waitForResponse(`${ingestion.url}/health`, ingestion, "DON ingestion Worker", {
      authorization: `Bearer ${administrationKey}`,
    }),
  ]);
  const administrationEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: ingestion.url,
  };
  const reconciled = await ingestAndReconcile({
    adapter: "fixture-one-piece-json@3",
    game: "one-piece",
    idempotencyKey: "acceptance-don-legality",
    lineage: "one-piece-en",
    sourcePath: "/don-legality",
    environment: administrationEnvironment,
    ingestion,
  });
  const don = reconciled.cards.find(
    (card) => card.official_identity.kind === "functional_designation" && card.official_identity.value === "DON!!",
  );
  assert.ok(don, "fixture ingestion omitted the functional DON!! Card");
  const publication = await approve(reconciled, "approve-acceptance-don-legality", administrationEnvironment);
  assert.equal(publication.publication_outcome, "revision");

  await stopWorker(ingestion);
  api = await startWorker({
    config: apiConfig,
    envFile: apiEnv,
    statePath,
  });
  await waitForResponse(`${api.url}/health`, api, "DON API Worker", { authorization: `Bearer ${apiKey}` });
  const response = await fetch(`${api.url}/v1/cards/${don.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const document = await response.json();
  assert.equal(response.status, 200);
  assert.equal(document.data.id, don.id);
  assert.deepEqual(document.data.official_identity, { kind: "functional_designation", value: "DON!!" });
  assert.equal(Object.hasOwn(document.data, "source_lineages"), false);
  const removed = await fetch(`${api.url}/v1/legality-status?card_id=${don.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(removed.status, 404);
});

async function ingestAndReconcile({
  adapter,
  environment,
  expectedRunState = "parsing",
  expectedStatus = 200,
  game = "gundam",
  idempotencyKey,
  ingestion,
  lineage,
  sourcePath,
}) {
  const collected = await runCli(
    [
      "source",
      "collect",
      "--game",
      game,
      "--lineage",
      lineage,
      "--adapter",
      adapter,
      "--request-id",
      "discovery",
      "--url",
      `https://official-source.invalid${sourcePath}`,
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ],
    environment,
  );
  if (collected.code !== 0) {
    throw new Error(
      `source collect exited ${collected.code}\n${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`,
    );
  }
  const run = JSON.parse(collected.stdout);
  if (run.state === "collecting") {
    const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
    if (resumed.code !== 0) {
      const shown = await runCli(["source", "show", "--run-id", run.id, "--json"], environment);
      const state = shown.code === 0 ? JSON.parse(shown.stdout).state : null;
      if (state !== "parsing") {
        throw new Error(`source resume exited ${resumed.code} in state ${state}\n${resumed.stdout}\n${resumed.stderr}`);
      }
    }
  }
  const reached = await waitForRunState(
    run.id,
    expectedRunState,
    environment,
    ingestion,
    // Poll below the administration-rate budget instead of manufacturing a
    // hot client.
    { deadlineMs: 90_000 },
  );
  if (expectedRunState === "failed") return reached;
  const reconciliationUrl = `${environment.KEEPR_INGESTION_URL}/v1/ingestion-runs/${run.id}/reconciliation`;
  const reconciliationBody = JSON.stringify({
    expected_current_revision_id: reached.expected_current_revision_id,
    idempotency_key: `${idempotencyKey}-reconcile`,
  });
  const deadline = Date.now() + 15_000;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    const response = await fetch(reconciliationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: reconciliationBody,
    });
    if (response.status === 429) {
      throw new Error(`ADMINISTRATION_RATE_LIMIT returned HTTP 429 on poll ${pollCount} while reconciling ${run.id}.`);
    }
    const observed = await response.json();
    if (response.status !== 200 && response.status !== 202) {
      if (expectedStatus !== null) {
        assert.equal(response.status, expectedStatus, JSON.stringify(observed));
      }
      return { ...observed, http_status: response.status };
    }
    if (observed.status === "complete" && observed.output !== null) {
      const candidateStatus = observed.output.publishable === true ? 200 : 409;
      if (expectedStatus !== null) {
        assert.equal(candidateStatus, expectedStatus, `${JSON.stringify(observed.output)}\n${ingestion.getOutput()}`);
      }
      return { ...observed.output, http_status: candidateStatus };
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, administrationPollInterval(ingestion)));
  }
  throw new Error(`reconciliation Workflow ${run.id} did not complete`);
}

async function approve(document, idempotencyKey, environment) {
  const result = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      document.run_id,
      "--candidate-digest",
      document.candidate_digest,
      "--expected-current-revision",
      document.expected_current_revision_id,
      "--idempotency-key",
      idempotencyKey,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function _reject(document, idempotencyKey, environment) {
  const result = await runCli(
    [
      "run",
      "reject",
      "--run-id",
      document.run_id,
      "--candidate-digest",
      document.candidate_digest,
      "--idempotency-key",
      idempotencyKey,
      "--yes",
      "--json",
    ],
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

async function _legalityStatus(cardId, extraArguments, environment) {
  const result = await runCli(legalityArguments(cardId, extraArguments), environment);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function legalityArguments(cardId, extraArguments) {
  const onIndex = extraArguments.indexOf("--on");
  const on = onIndex === -1 ? "2026-07-30" : extraArguments[onIndex + 1];
  const filtered =
    onIndex === -1
      ? extraArguments
      : extraArguments.filter((_argument, index) => index !== onIndex && index !== onIndex + 1);
  return [
    "legality",
    "status",
    "--card-id",
    cardId,
    "--on",
    on,
    "--format",
    "standard",
    "--event-tier",
    "championship",
    ...filtered,
    "--json",
  ];
}

function _assertGoldenComponent(bytes, component, golden) {
  assert.equal(component.name, golden.component);
  assert.equal(component.content_sha256, golden.content_sha256);
  assert.equal(component.compressed_sha256, golden.compressed_sha256);
  assert.equal(Buffer.from(bytes).toString("base64"), golden.gzip_base64);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), golden.compressed_sha256);
}

function _fixedDeflateBlockCount(gzipBytes) {
  const reader = new DeflateBitReader(gzipBytes.subarray(10, gzipBytes.length - 8));
  const literalTable = fixedLiteralTable();
  const distanceTable = canonicalDecodeTable(Array.from({ length: 32 }, () => 5));
  const lengthExtraBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distanceExtraBits = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
  ];
  let blocks = 0;
  while (true) {
    const final = reader.readBits(1);
    assert.equal(reader.readBits(2), 1, "golden DEFLATE contains a non-fixed block");
    blocks += 1;
    while (true) {
      const symbol = decodeSymbol(reader, literalTable, 9);
      if (symbol < 256) continue;
      if (symbol === 256) break;
      assert.ok(symbol >= 257 && symbol <= 285);
      reader.readBits(lengthExtraBits[symbol - 257]);
      const distance = decodeSymbol(reader, distanceTable, 5);
      assert.ok(distance <= 29);
      reader.readBits(distanceExtraBits[distance]);
    }
    if (final === 1) return blocks;
  }
}

class DeflateBitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readBits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.offset >> 3];
      assert.notEqual(byte, undefined, "truncated golden DEFLATE");
      value |= ((byte >> (this.offset & 7)) & 1) << index;
      this.offset += 1;
    }
    return value;
  }
}

function fixedLiteralTable() {
  const lengths = Array.from({ length: 288 }, (_, symbol) =>
    symbol <= 143 ? 8 : symbol <= 255 ? 9 : symbol <= 279 ? 7 : 8,
  );
  return canonicalDecodeTable(lengths);
}

function canonicalDecodeTable(lengths) {
  const counts = [];
  for (const length of lengths) {
    counts[length] = (counts[length] ?? 0) + 1;
  }
  const nextCode = [];
  let code = 0;
  for (let bits = 1; bits <= Math.max(...lengths); bits += 1) {
    code = (code + (counts[bits - 1] ?? 0)) << 1;
    nextCode[bits] = code;
  }
  const table = new Map();
  for (const [symbol, length] of lengths.entries()) {
    const canonical = nextCode[length]++;
    table.set(`${length}:${reverseBits(canonical, length)}`, symbol);
  }
  return table;
}

function decodeSymbol(reader, table, maximumBits) {
  let code = 0;
  for (let length = 1; length <= maximumBits; length += 1) {
    code |= reader.readBits(1) << (length - 1);
    const symbol = table.get(`${length}:${code}`);
    if (symbol !== undefined) return symbol;
  }
  assert.fail("golden DEFLATE contains an invalid fixed-Huffman code");
}

function reverseBits(value, length) {
  let reversed = 0;
  for (let index = 0; index < length; index += 1) {
    reversed = (reversed << 1) | ((value >> index) & 1);
  }
  return reversed;
}

function _canonicalRuleId(sourceLineage, officialId) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        official_id: officialId,
        source_lineage: sourceLineage,
      }),
    )
    .digest("hex");
  return `legality_rule_${digest}`;
}

async function localConfig(source, directory, name, overrides = {}) {
  const config = JSON.parse(readFileSync(resolve(root, source), "utf8"));
  delete config.$schema;
  config.main = resolve(root, source.split("/").slice(0, -1).join("/"), config.main);
  if (Array.isArray(config.d1_databases)) {
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  }
  // Immediate source pacing compresses this scenario's administration calls
  // into a window far shorter than the production budget assumes.
  const administrationRateLimit = config.ratelimits?.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT");
  if (administrationRateLimit !== undefined) {
    administrationRateLimit.simple.limit = 300;
  }
  Object.assign(config, overrides);
  const path = join(directory, `${name}.wrangler.json`);
  await writeFile(path, JSON.stringify(config));
  return path;
}
