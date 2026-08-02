import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const failureCases = [
  {
    name: "a missing required Official Source surface",
    path: "/raw-one-piece-failure-missing-surface",
    failure: "omission",
    portOffset: 0,
  },
  {
    name: "an Official Source result cap",
    path: "/raw-one-piece-failure-result-cap",
    failure: "cap",
    portOffset: 10,
  },
  {
    name: "unfinished Official Source pagination",
    path: "/raw-one-piece-failure-pagination",
    failure: "pagination",
    portOffset: 20,
  },
];

for (const failureCase of failureCases) {
  test(`the CLI-to-Worker boundary fails closed for ${failureCase.name}`, async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "card-keepr-official-failure-"),
    );
    const administrationKey = crypto.randomUUID();
    const ingestionEnv = join(directory, "ingestion.env");
    const ingestionConfig = join(directory, "ingestion.wrangler.json");
    const planPath = join(directory, "source-plan.json");
    const ingestionState = join(directory, "ingestion-state");
    const ingestionPort = 24_788 + failureCase.portOffset;
    const sourcePort = 24_789 + failureCase.portOffset;
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
    config.main = resolve(root, "apps/ingestion/src/index.ts");
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
    config.services = [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: "card-keepr-synthetic-official-source",
      },
    ];
    await writeFile(ingestionConfig, JSON.stringify(config));
    const requests = exactOnePieceRequests();
    if (failureCase.failure === "omission") {
      requests.pop();
    } else {
      requests[0].headers = {
        "user-agent":
          `card-keepr-acceptance-parser/${failureCase.failure}`,
      };
    }
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [{
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-en@2",
          requests,
        }],
      }),
    );

    const source = startWorker({
      config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
      inspectorPort: 25_229 + failureCase.portOffset,
      port: sourcePort,
      statePath: join(directory, "source-state"),
    });
    const ingestion = startWorker({
      config: ingestionConfig,
      envFile: ingestionEnv,
      inspectorPort: 25_230 + failureCase.portOffset,
      migrate: true,
      port: ingestionPort,
      statePath: ingestionState,
    });
    t.after(async () => {
      await Promise.all([stopWorker(source), stopWorker(ingestion)]);
      await rm(directory, { recursive: true, force: true });
    });
    await Promise.all([
      waitForResponse(
        `http://127.0.0.1:${sourcePort}${failureCase.path}`,
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
    const collected = await runCli(
      [
        "source",
        "collect",
        "--plan-file",
        planPath,
        "--idempotency-key",
        `official-failure-${failureCase.portOffset}`,
        "--json",
      ],
      cliEnvironment,
    );
    if (failureCase.failure === "omission") {
      assert.notEqual(collected.code, 0);
      assert.deepEqual(JSON.parse(collected.stdout), {
        contract: "card-keepr-cli-problem@1",
        status: "error",
        code: "invalid_parameter",
        detail:
          "requests must contain between 1 and 100 Official Source requests.",
      });
      return;
    }
    assert.equal(
      collected.code,
      0,
      `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`,
    );
    const run = JSON.parse(collected.stdout);
    const resumed = await runCli(
      ["source", "resume", "--run-id", run.id, "--json"],
      cliEnvironment,
    );
    assert.equal(
      resumed.code,
      0,
      `${resumed.stdout}\n${resumed.stderr}\n${ingestion.getOutput()}`,
    );

    const failed = await waitForFailedRun(
      run.id,
      cliEnvironment,
      ingestion,
    );
    assert.equal(failed.failure_code, "source_parse_failed");
    assert.equal(failed.snapshots.length, 8);
    assert.equal(failed.observation_sets.length, 7);
  });
}

function exactOnePieceRequests() {
  return [{
    id: "one-piece-en:discovery",
    url: "https://en.onepiece-cardgame.com/cardlist/",
  }];
}

async function waitForFailedRun(runId, environment, ingestion) {
  const deadline = Date.now() + 90_000;
  let lastDocument = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      const document = JSON.parse(shown.stdout);
      lastDocument = document;
      if (document.state === "failed") return document;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Ingestion Run ${runId} did not fail: ${JSON.stringify(lastDocument)}\n` +
      ingestion.getOutput(),
  );
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
