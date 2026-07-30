import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const ingestionPort = 20_788;

test("synthetic fixture publication is unavailable through the production Worker and CLI seams", async (t) => {
  const testDirectory = await mkdtemp(
    join(tmpdir(), "card-keepr-publication-boundary-"),
  );
  const statePath = join(testDirectory, "shared-state");
  const administrationKey = randomUUID();
  const ingestionEnv = join(testDirectory, "ingestion.env");
  await writeFile(
    ingestionEnv,
    `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
    { mode: 0o600 },
  );
  await applyMigrations(statePath);

  const ingestion = startWorker({
    config: "apps/ingestion/wrangler.jsonc",
    envFile: ingestionEnv,
    inspectorPort: 21_230,
    port: ingestionPort,
    statePath,
  });
  t.after(() => stopWorker(ingestion));
  await waitForHealth(
    `http://127.0.0.1:${ingestionPort}/health`,
    administrationKey,
    ingestion,
  );

  const response = await fetch(
    `http://127.0.0.1:${ingestionPort}/v1/ingestion-runs`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${administrationKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fixture: "first-catalogue",
        selected_games: ["one-piece"],
        idempotency_key: "production-fixture-publication-bypass",
      }),
    },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");

  const cliEnvironment = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const started = await runCli(
    [
      "run",
      "start",
      "--fixture",
      "first-catalogue",
      "--games",
      "one-piece",
      "--idempotency-key",
      "production-fixture-cli-bypass",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(started.code, 6, started.stderr);
  assert.deepEqual(JSON.parse(started.stdout), {
    contract: "card-keepr-cli-problem@1",
    status: "error",
    code: "not_found",
    detail: "The requested administration operation does not exist.",
  });

  const status = await runCli(["status", "--json"], cliEnvironment);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).active_ingestion_run, null);
});

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
