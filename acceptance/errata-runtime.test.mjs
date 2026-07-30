import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const runtimePort = 18_793;

test("an Erratum fixture publishes through the CLI and is consumed through authenticated HTTP and export bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-errata-"));
  const statePath = join(directory, "shared-state");
  const apiKey = crypto.randomUUID();
  const administrationKey = crypto.randomUUID();
  const environmentFile = join(directory, "runtime.env");
  const runtimeConfig = join(directory, "runtime.wrangler.json");
  await Promise.all([
    writeFile(
      environmentFile,
      `API_BEARER_KEY=${apiKey}\nADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    ),
    writeRuntimeConfig(runtimeConfig),
  ]);
  applyMigrations(runtimeConfig, statePath);

  const runtime = startWorker({
    config: runtimeConfig,
    envFile: environmentFile,
    inspectorPort: 19_234,
    port: runtimePort,
    statePath,
  });
  t.after(async () => {
    await stopWorker(runtime);
    await rm(directory, { recursive: true, force: true });
  });
  await waitForHealth(runtime, runtimePort, apiKey, "combined runtime");

  const cliEnvironment = {
    KEEPR_API_KEY: apiKey,
    KEEPR_API_URL: `http://127.0.0.1:${runtimePort}`,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: `http://127.0.0.1:${runtimePort}`,
  };
  const startedResponse = await fetch(
    `http://127.0.0.1:${runtimePort}/__test/errata-evidence`,
    {
      method: "POST",
      headers: {
        "x-card-keepr-acceptance-fixture": "errata-rules-text",
      },
    },
  );
  const startedText = await startedResponse.text();
  assert.equal(startedResponse.status, 201, startedText);
  const run = JSON.parse(startedText);
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(run.id, "parsing", cliEnvironment, runtime);
  const reconciled = await administrationJson(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    administrationKey,
    {},
  );
  assert.equal(reconciled.publishable, true);
  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  const card = reconciled.cards[0];
  const printing = reconciled.printings[0];
  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      run.id,
      "--candidate-digest",
      candidate.candidate_digest,
      "--expected-current-revision",
      candidate.expected_current_revision_id,
      "--idempotency-key",
      "errata-runtime-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    approved.code,
    0,
    `${approved.stdout}\n${approved.stderr}\n${runtime.getOutput()}`,
  );
  const revisionId = JSON.parse(approved.stdout).resulting_revision_id;

  const searched = await runCli(
    [
      "cards",
      "search",
      "--query",
      "draw 2 cards",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(searched.code, 0, searched.stderr);
  assert.equal(JSON.parse(searched.stdout).data[0].id, card.id);

  const cardRead = await apiJson(`/v1/cards/${card.id}`, apiKey);
  assert.equal(cardRead.data.effective_rules_text, "[On Play] Draw 2 cards.");
  const printingRead = await apiJson(
    `/v1/printings/${printing.id}`,
    apiKey,
  );
  assert.equal(printingRead.data.printed_rules_text, "[On Play] Draw 1 card.");
  const manifest = await apiJson(
    `/v1/catalogue-exports/${revisionId}`,
    apiKey,
  );
  assert.equal(manifest.meta.catalogue_revision_id, revisionId);

  const [cardsBytes, errataBytes] = await Promise.all([
    exportComponent(revisionId, "cards", apiKey),
    exportComponent(revisionId, "errata", apiKey),
  ]);
  const exportedCard = JSON.parse(cardsBytes.trim());
  const exportedErratum = JSON.parse(errataBytes.trim());
  assert.equal(exportedCard.id, card.id);
  assert.equal(
    exportedCard.effective_rules_text,
    "[On Play] Draw 2 cards.",
  );
  assert.equal(exportedErratum.target_id, card.id);
  assert.equal(exportedErratum.corrected_value, "[On Play] Draw 2 cards.");
  assert.doesNotMatch(cardsBytes + errataBytes, /snapshot|raw_payload/i);
});

async function writeRuntimeConfig(destination) {
  const config = JSON.parse(
    readFileSync(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  const apiConfig = JSON.parse(
    readFileSync(resolve(root, "apps/api/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.name = "card-keepr-combined-acceptance-runtime";
  config.main = resolve(
    root,
    "acceptance/fixtures/combined-card-keepr-runtime.ts",
  );
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.services = [{
    binding: "OFFICIAL_SOURCE_TRANSPORT",
    service: config.name,
    entrypoint: "AcceptanceOfficialSourceTransport",
  }];
  config.ratelimits.push(...apiConfig.ratelimits);
  config.vars.CORS_ALLOWED_ORIGINS = apiConfig.vars.CORS_ALLOWED_ORIGINS;
  await writeFile(destination, JSON.stringify(config));
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
        ...processEnvWithoutSecrets(),
        CI: "1",
        WRANGLER_LOG_PATH: join(statePath, "logs"),
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
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

async function waitForHealth(worker, port, key, name) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) {
      throw new Error(`${name} exited\n${worker.getOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not started accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`${name} did not become healthy\n${worker.getOutput()}`);
}

async function apiJson(pathname, apiKey) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}${pathname}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function administrationJson(pathname, key, body) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}${pathname}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForRunState(id, expected, environment, runtime) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", id, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      if (document.state === expected) return document;
      if (document.state === "failed") {
        throw new Error(`${shown.stdout}\n${runtime.getOutput()}`);
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Run ${id} did not reach ${expected}\n${runtime.getOutput()}`);
}

async function exportComponent(revisionId, component, apiKey) {
  const response = await fetch(
    `http://127.0.0.1:${runtimePort}/v1/catalogue-exports/${revisionId}/components/${component}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  if (response.status !== 200) {
    assert.equal(response.status, 200, await response.text());
  }
  return gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
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
  return new Promise((resolveRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: { ...processEnvWithoutSecrets(), ...environment },
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
    child.once("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function processEnvWithoutSecrets() {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return environment;
}
