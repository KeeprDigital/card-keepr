import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = resolve(import.meta.dirname, "..");
const portBase = 20_000 + (process.pid % 1_000) * 3;
const ingestionPort = portBase;
const sourcePort = portBase + 1;
const apiPort = portBase + 2;
const apiSchema = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/api.schema.json",
    ),
    "utf8",
  ),
);
const exportRecordSchemaV1 = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json",
    ),
    "utf8",
  ),
);
const exportRecordSchemaV2 = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v2.schema.json",
    ),
    "utf8",
  ),
);
const exportManifestSchemaV1 = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest.schema.json",
    ),
    "utf8",
  ),
);
const exportManifestSchemaV2 = JSON.parse(
  readFileSync(
    resolve(
      root,
      "prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v2.schema.json",
    ),
    "utf8",
  ),
);
const gzipGolden = JSON.parse(
  readFileSync(
    resolve(
      root,
      "acceptance/fixtures/catalogue-export-gzip-golden.json",
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(exportManifestSchemaV1);
ajv.addSchema(exportManifestSchemaV2);
ajv.addSchema(apiSchema);
ajv.addSchema(exportRecordSchemaV1);
ajv.addSchema(exportRecordSchemaV2);
const validateLegalityStatus = ajv.getSchema(
  `${apiSchema.$id}#/$defs/LegalityStatusDocument`,
);
const validateLegalityRuleExport = ajv.getSchema(
  `${exportRecordSchemaV2.$id}#/$defs/LegalityRuleRecord`,
);
const validateCatalogueExportDocument = ajv.getSchema(
  `${apiSchema.$id}#/$defs/CatalogueExportDocument`,
);

test("the public CLI fails closed for undemonstrated publisher JSON adapters", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-contextual-legality-fail-closed-"),
  );
  const administrationKey = crypto.randomUUID();
  const ingestionConfig = await localConfig(
    "apps/ingestion/wrangler.jsonc",
    directory,
    "ingestion",
  );
  const ingestionEnv = join(directory, "ingestion.env");
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${administrationKey}\n`,
    { mode: 0o600 },
  );
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: portBase + 102,
    migrate: true,
    port: ingestionPort,
    statePath: join(directory, "state"),
  });
  t.after(async () => {
    await stopWorker(ingestion);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForResponse(
    `http://127.0.0.1:${ingestionPort}/health`,
    ingestion,
    "ingestion Worker",
    { authorization: `Bearer ${administrationKey}` },
  );

  const result = await runCli(
    [
      "source",
      "collect",
      "--game",
      "gundam",
      "--lineage",
      "gundam-en-asia",
      "--adapter",
      "gundam-en-asia@2",
      "--request-id",
      "discovery",
      "--url",
      "https://www.gundam-gcg.com/asia-en/contextual-legality",
      "--idempotency-key",
      "acceptance-contextual-legality-undemonstrated-json",
      "--json",
    ],
    {
      KEEPR_ADMINISTRATION_KEY: administrationKey,
      KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    },
  );
  assert.equal(result.code, 8, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    {
      contract: "card-keepr-cli-problem@1",
      status: "error",
      code: "adapter_not_supported",
      detail: "The requested Official Source adapter version is not installed.",
    },
  );
});

async function ingestAndReconcile({
  adapter,
  environment,
  expectedRunState = "parsing",
  expectedStatus = 200,
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
      "gundam",
      "--lineage",
      lineage,
      "--adapter",
      adapter,
      "--request-id",
      "discovery",
      "--url",
      `https://www.gundam-gcg.com/${
        lineage === "gundam-en-asia" ? "asia-en" : "en"
      }${sourcePath}`,
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
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    environment,
  );
  if (resumed.code !== 0) {
    const shown = await runCli(
      ["source", "show", "--run-id", run.id, "--json"],
      environment,
    );
    const state =
      shown.code === 0 ? JSON.parse(shown.stdout).state : null;
    if (state !== "parsing") {
      throw new Error(
        `source resume exited ${resumed.code} in state ${state}\n${resumed.stdout}\n${resumed.stderr}`,
      );
    }
  }
  const reached = await waitForRunState(
    run.id,
    expectedRunState,
    environment,
    ingestion,
  );
  if (expectedRunState === "failed") return reached;
  const response = await fetch(
    `${environment.KEEPR_INGESTION_URL}/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  const document = await response.json();
  if (expectedStatus !== null) {
    assert.equal(
      response.status,
      expectedStatus,
      `${JSON.stringify(document)}\n${ingestion.getOutput()}`,
    );
  }
  return { ...document, http_status: response.status };
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

async function reject(document, idempotencyKey, environment) {
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

async function legalityStatus(cardId, extraArguments, environment) {
  const result = await runCli(
    legalityArguments(cardId, extraArguments),
    environment,
  );
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function legalityArguments(cardId, extraArguments) {
  const onIndex = extraArguments.indexOf("--on");
  const on =
    onIndex === -1 ? "2026-07-30" : extraArguments[onIndex + 1];
  const filtered =
    onIndex === -1
      ? extraArguments
      : extraArguments.filter(
          (_argument, index) => index !== onIndex && index !== onIndex + 1,
        );
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

function assertGoldenComponent(bytes, component, golden) {
  assert.equal(component.name, golden.component);
  assert.equal(component.content_sha256, golden.content_sha256);
  assert.equal(
    component.compressed_sha256,
    golden.compressed_sha256,
  );
  assert.equal(Buffer.from(bytes).toString("base64"), golden.gzip_base64);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    golden.compressed_sha256,
  );
}

function fixedDeflateBlockCount(gzipBytes) {
  const reader = new DeflateBitReader(
    gzipBytes.subarray(10, gzipBytes.length - 8),
  );
  const literalTable = fixedLiteralTable();
  const distanceTable = canonicalDecodeTable(
    Array.from({ length: 32 }, () => 5),
  );
  const lengthExtraBits = [
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 1, 1, 1,
    2, 2, 2, 2,
    3, 3, 3, 3,
    4, 4, 4, 4,
    5, 5, 5, 5,
    0,
  ];
  const distanceExtraBits = [
    0, 0, 0, 0,
    1, 1,
    2, 2,
    3, 3,
    4, 4,
    5, 5,
    6, 6,
    7, 7,
    8, 8,
    9, 9,
    10, 10,
    11, 11,
    12, 12,
    13, 13,
  ];
  let blocks = 0;
  while (true) {
    const final = reader.readBits(1);
    assert.equal(
      reader.readBits(2),
      1,
      "golden DEFLATE contains a non-fixed block",
    );
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

function canonicalRuleId(sourceLineage, officialId) {
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

async function waitForRunState(runId, expected, environment, worker) {
  const deadline = Date.now() + 90_000;
  let lastShown = "";
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      lastShown = shown.stdout;
      const document = JSON.parse(shown.stdout);
      if (document.state === expected) return document;
      if (document.state === "failed") {
        throw new Error(`${shown.stdout}\n${worker.getOutput()}`);
      }
    }
    // Workflow collection is asynchronous. Poll below the production
    // administration-rate budget instead of manufacturing a hot client.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error(
    `run ${runId} did not reach ${expected}\n${lastShown}\n${worker.getOutput()}`,
  );
}

async function localConfig(source, directory, name, overrides = {}) {
  const config = JSON.parse(readFileSync(resolve(root, source), "utf8"));
  delete config.$schema;
  config.main = resolve(
    root,
    source.split("/").slice(0, -1).join("/"),
    config.main,
  );
  if (Array.isArray(config.d1_databases)) {
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  }
  Object.assign(config, overrides);
  const path = join(directory, `${name}.wrangler.json`);
  await writeFile(path, JSON.stringify(config));
  return path;
}

function startWorker({
  config,
  envFile,
  inspectorPort,
  migrate = false,
  port,
  statePath,
}) {
  if (migrate) applyMigrations(config, statePath);
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
      env: {
        ...process.env,
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

function applyMigrations(config, statePath) {
  const result = spawnSync(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1",
      "migrations",
      "apply",
      "CATALOGUE_DB",
      "--local",
      "--config",
      config,
      "--persist-to",
      statePath,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        CI: "1",
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

async function waitForResponse(url, worker, name, headers = {}) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(
        `${name} exited with ${worker.process.exitCode}\n${worker.getOutput()}`,
      );
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // Wrangler has not started accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${name} did not become ready\n${worker.getOutput()}`);
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
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}
