import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");

test("the owner publishes a complete One Piece catalogue for authenticated consumers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-one-piece-"));
  const statePath = join(directory, "state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "plan.json");
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(planPath, JSON.stringify({
      plans: [{
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "one-piece-en@3",
        requests: [{
          id: "one-piece-en:discovery",
          url: "https://en.onepiece-cardgame.com/cardlist/",
          headers: {
            accept: "text/html",
            "user-agent": "card-keepr-one-piece-complete-v1",
          },
        }],
      }],
    }), { mode: 0o600 }),
  ]);
  await applyMigrations(statePath);
  const config = JSON.parse(
    await readFile(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.services = [{
    binding: "OFFICIAL_SOURCE_TRANSPORT",
    service: "card-keepr-synthetic-official-source",
  }];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    inspectorPort: 27_229,
    port: 27_790,
    statePath: join(directory, "source-state"),
  });
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 27_230,
    port: 27_788,
    statePath,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(
      "http://127.0.0.1:27790/catalogue-discovery",
      "",
      source,
    ),
    waitForHealth(
      "http://127.0.0.1:27788/health",
      administrationKey,
      ingestion,
    ),
  ]);
  const cliEnvironment = {
    KEEPR_INGESTION_URL: "http://127.0.0.1:27788",
    KEEPR_ADMINISTRATION_KEY: administrationKey,
  };
  const collected = await runCli([
    "source",
    "collect",
    "--plan-file",
    planPath,
    "--idempotency-key",
    "one-piece-complete-collect",
    "--json",
  ], cliEnvironment);
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
  assert.equal(resumed.code, 0, resumed.stderr);
  const ready = await waitForRunState(
    run.id,
    "awaiting_approval",
    cliEnvironment,
    { getOutput: () => `${ingestion.getOutput()}\n${source.getOutput()}` },
  );
  assert.ok(
    ready.snapshots.every(({ content }) =>
      /^[0-9a-f]{64}$/u.test(content.digest)
    ),
    "every collected surface and image is retained with provenance",
  );
  assert.deepEqual(
    ready.evidence_plans[0].requests.map(({ id }) => id),
    ["one-piece-en:discovery"],
    "the immutable Evidence Plan remains the single discovery request",
  );
  assert.ok(
    ready.snapshots.some(({ request }) =>
      new URL(request.url).searchParams.get("recording") === "2201"
    ),
  );
  assert.ok(
    ready.snapshots.some(({ request }) =>
      new URL(request.url).searchParams.get("recording") === "2202"
    ),
  );
  for (const [recording, expectedCount] of [["2201", 1], ["2202", 2]]) {
    const snapshot = ready.snapshots.find(({ request }) =>
      new URL(request.url).searchParams.get("recording") === recording
    );
    const observationSet = ready.observation_sets.find(
      ({ source_snapshot_id }) => source_snapshot_id === snapshot.id,
    );
    assert.equal(observationSet.observation_count, expectedCount);
  }

  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const candidate = JSON.parse(inspected.stdout);
  assert.equal(candidate.diff.summary.cards_added, 3);
  assert.equal(candidate.diff.summary.printings_added, 2);
  assert.ok(candidate.diff.warnings.some(
    ({ code, raw_value }) =>
      code === "unknown_source_field" &&
      raw_value === "New optional publisher vocabulary",
  ));
  const approved = await runCli([
    "run",
    "approve",
    "--run-id",
    run.id,
    "--candidate-digest",
    candidate.candidate_digest,
    "--expected-current-revision",
    "catrev_spine_000",
    "--idempotency-key",
    "one-piece-complete-approve",
    "--yes",
    "--json",
  ], cliEnvironment);
  assert.equal(
    approved.code,
    0,
    `${approved.stdout}\n${approved.stderr}\n${ingestion.getOutput()}`,
  );
  const revisionId = JSON.parse(approved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 27_231,
    port: 27_789,
    statePath,
  });
  t.after(() => stopWorker(api));
  await waitForHealth("http://127.0.0.1:27789/health", apiKey, api);
  const [cards, printings, images, products, releases, legality] =
    await Promise.all([
      "cards",
      "printings",
      "printing-images",
      "products",
      "releases",
      "legality-rules",
    ].map((component) => exportRecords(27_789, apiKey, revisionId, component)));
  assert.equal(cards.length, 3);
  assert.equal(printings.length, 2);
  assert.equal(images.length, 2);
  assert.equal(products.length, 1);
  assert.equal(releases.length, 1);
  assert.equal(legality.length, 1);

  const leader = cards.find(
    ({ official_identity }) => official_identity.value === "OP31-001",
  );
  assert.deepEqual(leader.game_data, {
    profile: "one-piece@1",
    attributes: {
      card_type: "leader",
      colours: ["green", "red"],
      cost: null,
      life: 5,
      battle_attributes: ["strike"],
      power: 5000,
      counter: null,
      traits: ["Straw Hat Crew"],
      block_icons: ["1"],
      effect_text: "Give up to 1 rested DON!! card to this Leader.",
      trigger_text: null,
    },
  });
  const don = cards.find(
    ({ official_identity }) => official_identity.kind === "functional_designation",
  );
  assert.deepEqual(don.official_identity, {
    kind: "functional_designation",
    value: "DON!!",
  });
  assert.equal(don.game_data.attributes.card_type, "don");
  assert.equal(
    printings.some(({ card_id }) => card_id === don.id),
    false,
    "the generic DON!! Card makes no comprehensive Printing promise",
  );

  const leaderPrinting = printings.find(({ card_id }) => card_id === leader.id);
  const printingResponse = await fetch(
    `http://127.0.0.1:27789/v1/printings/${leaderPrinting.id}?include=evidence`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(printingResponse.status, 200);
  const printingDocument = await printingResponse.json();
  assert.deepEqual(
    printingDocument.data.locator_evidence.current.map(({ locator }) => locator),
    ["OP31-001_p1"],
    "repeated Recording evidence aggregates onto one Printing locator",
  );
});

async function exportRecords(port, apiKey, revisionId, component) {
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/catalogue-exports/${revisionId}/components/${component}`,
    { headers: { authorization: `Bearer ${apiKey}` } },
  );
  assert.equal(response.status, 200);
  const body = gunzipSync(Buffer.from(await response.arrayBuffer()))
    .toString("utf8").trim();
  return body === "" ? [] : body.split("\n").map((line) => JSON.parse(line));
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

async function waitForRunState(runId, state, environment, worker) {
  const deadline = Date.now() + 90_000;
  let last = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      last = JSON.parse(shown.stdout);
      if (last.state === state) return last;
      if (last.state === "failed") break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    `Run did not reach ${state}: ${JSON.stringify(last)}\n${worker.getOutput()}`,
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
      // Wrangler has not started accepting requests.
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
    { ...process.env, ...environment },
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
