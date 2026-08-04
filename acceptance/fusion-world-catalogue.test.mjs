import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const ingestionPort = 24_788;
const apiPort = 24_789;
const sourcePort = 24_790;

test("the owner publishes a complete Fusion World source for authenticated consumers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-fusion-world-"));
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "fusion-world-source-plan.json");
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify({
        plans: [{
          supported_game: "fusion-world",
          source_lineage: "fusion-world-en",
          adapter_version: "fusion-world-en@3",
          requests: [{
            id: "fusion-world-en:discovery",
            url: "https://www.dbs-cardgame.com/fw/en/cardlist/",
            headers: {
              accept: "text/html",
              "user-agent": "card-keepr-acceptance-fusion-world-issue-32",
            },
          }],
        }],
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
  config.services = [{
    binding: "OFFICIAL_SOURCE_TRANSPORT",
    service: "card-keepr-fusion-world-official-source",
  }];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = startWorker({
    config: "acceptance/fixtures/fusion-world-official-source.wrangler.jsonc",
    inspectorPort: 25_229,
    port: sourcePort,
    statePath: join(directory, "source-state"),
  });
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 25_230,
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
  const collected = await runCli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "fusion-world-issue-32-collect",
    "--json",
  ], cliEnvironment);
  assert.equal(collected.code, 0, `${collected.stderr}\n${ingestion.getOutput()}`);
  const runId = JSON.parse(collected.stdout).id;
  const resumed = await runCli(
    ["source", "resume", "--run-id", runId, "--json"],
    cliEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForRunState(runId, "awaiting_approval", cliEnvironment, ingestion);

  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", runId, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.diff.summary.cards_added, 1);
  assert.equal(candidate.diff.summary.printings_added, 1);
  const approved = await runCli([
    "run",
    "approve",
    "--run-id",
    runId,
    "--candidate-digest",
    candidate.candidate_digest,
    "--expected-current-revision",
    "catrev_spine_000",
    "--idempotency-key",
    "fusion-world-issue-32-approve",
    "--yes",
    "--json",
  ], cliEnvironment);
  assert.equal(approved.code, 0, `${approved.stderr}\n${ingestion.getOutput()}`);
  const firstRevisionId = JSON.parse(approved.stdout).resulting_revision_id;

  const errataPlan = JSON.parse(await readFile(planPath, "utf8"));
  errataPlan.plans[0].requests[0].headers["user-agent"] =
    "card-keepr-acceptance-fusion-world-issue-32-errata";
  await writeFile(planPath, JSON.stringify(errataPlan), { mode: 0o600 });
  const errataCollected = await runCli([
    "source", "collect", "--plan-file", planPath,
    "--idempotency-key", "fusion-world-issue-32-errata-collect", "--json",
  ], cliEnvironment);
  assert.equal(
    errataCollected.code,
    0,
    `${errataCollected.stderr}\n${ingestion.getOutput()}`,
  );
  const errataRunId = JSON.parse(errataCollected.stdout).id;
  const errataResumed = await runCli(
    ["source", "resume", "--run-id", errataRunId, "--json"],
    cliEnvironment,
  );
  assert.equal(errataResumed.code, 0, errataResumed.stderr);
  await waitForRunState(
    errataRunId,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
  );
  const errataInspected = await runCli(
    ["candidate", "inspect", "--run-id", errataRunId, "--json"],
    cliEnvironment,
  );
  assert.equal(errataInspected.code, 0, errataInspected.stderr);
  const errataCandidate = JSON.parse(errataInspected.stdout);
  const errataApproved = await runCli([
    "run", "approve", "--run-id", errataRunId,
    "--candidate-digest", errataCandidate.candidate_digest,
    "--expected-current-revision", firstRevisionId,
    "--idempotency-key", "fusion-world-issue-32-errata-approve",
    "--yes", "--json",
  ], cliEnvironment);
  assert.equal(
    errataApproved.code,
    0,
    `${errataApproved.stderr}\n${ingestion.getOutput()}`,
  );
  const revisionId = JSON.parse(errataApproved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 25_231,
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
  const catalogue = await catalogueResponse.json();
  assert.deepEqual(
    catalogue.data.last_successful_checks
      .filter(({ game }) => game === "fusion-world")
      .map(({ area }) => area),
    ["cards-and-printings", "legality-rules", "products-and-releases"],
  );

  const [cards, printings, images, products, releases, errata] =
    await Promise.all([
      "cards",
      "printings",
      "printing-images",
      "products",
      "releases",
      "errata",
    ].map((component) =>
      exportRecords(apiPort, apiKey, revisionId, component)
    ));
  assert.equal(cards.length, 1);
  assert.equal(printings.length, 1);
  assert.equal(products.length, 1);
  assert.equal(releases.length, 1);
  assert.equal(errata.length, 1);

  const card = cards[0];
  assert.equal(card.official_identity.value, "FB99-001");
  assert.equal(card.effective_rules_text, "Official corrected rules");
  assert.deepEqual(card.game_data, {
    profile: "fusion-world@1",
    attributes: {
      card_type: "leader",
      colours: ["red"],
      cost: 1,
      specified_cost: [{ colour: "red", count: 1 }],
      power: 10000,
      combo_power: 5000,
      traits: ["Test"],
      skills: [{ kind: "ordinary", text: "Official skill" }],
      leader_faces: [
        {
          role: "front",
          name: "Fusion Leader Front",
          power: 10000,
          traits: ["Test"],
          skills: "Official front skill",
        },
        {
          role: "back",
          name: "Fusion Leader Back",
          power: 15000,
          traits: ["Test"],
          skills: "Official back skill",
        },
      ],
    },
  });
  assert.equal(JSON.stringify(card.game_data).includes("FB99-001_p2"), false);
  assert.equal(printings[0].printed_rules_text, "Official printed rules");
  assert.deepEqual(
    printings[0].locator_evidence.current.map(({ locator }) => locator),
    ["FB99-001_p2"],
  );
  assert.deepEqual(images.map(({ role }) => role).sort(), ["back", "front"]);
  assert.equal(products[0].official_code, "FB-RAW-01");
  assert.equal(products[0].name, "Fusion World Raw Product");
  assert.equal(releases[0].product_id, products[0].id);
  assert.equal(releases[0].region, "EN-US");
  assert.equal(releases[0].status, "released");
  assert.equal(errata[0].target_id, card.id);
  assert.equal(errata[0].effective_from, "2026-07-15");
  assert.equal(errata[0].corrected_value, "Official corrected rules");
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
      "d1", "migrations", "apply", "CATALOGUE_DB", "--local",
      "--config", "apps/ingestion/wrangler.jsonc", "--persist-to", statePath,
    ],
    { ...processEnvironment(statePath), CI: "1" },
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

function startWorker({ config, envFile, inspectorPort, port, statePath }) {
  let output = "";
  const child = spawn(resolve(root, "node_modules/.bin/wrangler"), [
    "dev", "--config", config,
    ...(envFile === undefined ? [] : ["--env-file", envFile]),
    "--local", "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(inspectorPort), "--persist-to", statePath,
    "--log-level", "error", "--show-interactive-dev-session", "false",
  ], {
    cwd: root,
    env: processEnvironment(statePath),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  return { process: child, getOutput: () => output };
}

async function waitForRunState(runId, expectedState, environment, worker) {
  const deadline = Date.now() + 25_000;
  let last = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      last = JSON.parse(shown.stdout);
      if (last.state === expectedState) return last;
      if (last.state === "failed") break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Run did not reach ${expectedState}: ${JSON.stringify(last)}\n${worker.getOutput()}`,
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
    { ...processEnvironment("/tmp"), ...environment },
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
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("exit", (code) => resolveExit({ code, stdout, stderr }));
  });
}

function processEnvironment(statePath) {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return { ...environment, WRANGLER_LOG_PATH: join(statePath, "logs") };
}
