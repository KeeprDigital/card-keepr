import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const ingestionPort = 18_789;
const sourcePort = 18_790;

test("the CLI audits real retained evidence through a locally emulated ingestion Worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-evidence-cli-"));
  const administrationKey = crypto.randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${administrationKey}\n`,
    { mode: 0o600 },
  );
  const config = JSON.parse(
    readFileSync(
      resolve(root, "apps/ingestion/wrangler.jsonc"),
      "utf8",
    ),
  );
  delete config.$schema;
  config.main = resolve(
    root,
    "acceptance/fixtures/contextual-legality-ingestion-harness.ts",
  );
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
    inspectorPort: 19_232,
    port: sourcePort,
    statePath: join(directory, "source-state"),
  });
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 19_231,
    port: ingestionPort,
    statePath: join(directory, "ingestion-state"),
    migrate: true,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(
      `http://127.0.0.1:${sourcePort}/success`,
      source,
      "synthetic Official Source",
    ),
    waitForResponse(
      `http://127.0.0.1:${ingestionPort}/health`,
      ingestion,
      "ingestion Worker",
      { authorization: `Bearer ${administrationKey}` },
    ),
  ]);

  const cliEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
  };
  const rejected = await collectResumeAndShow(
    "cli_rejected_evidence_001",
    "redirect",
    "failed",
    cliEnvironment,
    ingestion,
    directory,
  );
  assert.equal(rejected.failure_code, "source_redirect_rejected");
  assert.equal(rejected.snapshots.length, 6);
  assert.equal(rejected.observation_sets.length, 6);
  assert.equal(rejected.diagnostics.length, 7);
  assert.equal(
    rejected.diagnostics.find(
      ({ request_id }) => request_id === "one-piece-en:card-list",
    )?.outcome,
    "redirect",
  );

  const terminalFailure = await collectResumeAndShow(
    "cli_terminal_evidence_001",
    "unavailable",
    "failed",
    cliEnvironment,
    ingestion,
    directory,
  );
  assert.equal(
    terminalFailure.failure_code,
    "source_request_retries_exhausted",
  );
  assert.equal(terminalFailure.snapshots.length, 6);
  assert.equal(terminalFailure.observation_sets.length, 6);
  assert.equal(terminalFailure.diagnostics.length, 10);

  const successful = await collectResumeAndShow(
    "cli_success_evidence_001",
    null,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
    directory,
  );
  assert.equal(successful.failure_code, null);
  assert.equal(successful.snapshots.length, 8);
  assert.equal(successful.observation_sets.length, 8);
  assert.equal(successful.diagnostics.length, 8);
  assert.match(successful.snapshots[0].content.digest, /^[a-f0-9]{64}$/);

  const retained = await runCli(
    ["source", "show", "--run-id", successful.id, "--json"],
    cliEnvironment,
  );
  assert.equal(retained.code, 0, retained.stderr);
  assert.deepEqual(JSON.parse(retained.stdout), successful);
});

async function collectResumeAndShow(
  idempotencyKey,
  transportOutcome,
  expectedState,
  environment,
  ingestion,
  directory,
) {
  const planFile = join(directory, `${idempotencyKey}.json`);
  const requests = exactOnePieceRequests();
  if (transportOutcome !== null) {
    requests[0].headers = {
      "user-agent":
        `card-keepr-acceptance-transport/${transportOutcome}`,
    };
  }
  await writeFile(
    planFile,
    JSON.stringify({
      plans: [{
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "one-piece-en@2",
        requests,
      }],
    }),
  );
  const collected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      planFile,
      "--idempotency-key",
      idempotencyKey,
      "--json",
    ],
    environment,
  );
  assert.equal(collected.code, 0, collected.stderr);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    environment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);

  const deadline = Date.now() + 20_000;
  let lastDocument = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", run.id, "--json"],
      environment,
    );
    if (
      shown.code === 9 &&
      parseCliErrorCode(shown.stdout) === "runtime_unavailable"
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      continue;
    }
    assert.equal(
      shown.code,
      0,
      `${shown.stdout}\n${shown.stderr}\n${ingestion.getOutput()}`,
    );
    const document = JSON.parse(shown.stdout);
    lastDocument = document;
    if (document.state === expectedState) return document;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Ingestion Run ${run.id} did not reach ${expectedState}: ${JSON.stringify({
      state: lastDocument?.state,
      failure_code: lastDocument?.failure_code,
      warnings: lastDocument?.warnings,
    })}\n${ingestion.getOutput()}`,
  );
}

function exactOnePieceRequests() {
  return Object.entries({
    "card-list": "https://en.onepiece-cardgame.com/cardlist/",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    restrictions:
      "https://en.onepiece-cardgame.com/rules/restriction/",
    "block-policy":
      "https://en.onepiece-cardgame.com/rules/block_icon/",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
    "don-rules": "https://en.onepiece-cardgame.com/rules/",
  }).map(([surface, url]) => ({
    id: `one-piece-en:${surface}`,
    url,
  }));
}

function parseCliErrorCode(stdout) {
  try {
    return JSON.parse(stdout).code;
  } catch {
    return undefined;
  }
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
  const arguments_ = [
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
  ];
  const child = spawn(resolve(root, "node_modules/.bin/wrangler"), arguments_, {
    cwd: root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(statePath, "logs"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
