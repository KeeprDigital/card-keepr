import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const ingestionPort = 28_788;
const apiPort = 28_789;
const sourcePort = 28_790;

test("the owner publishes a complete Digimon catalogue consumed through authenticated HTTP", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-digimon-boundary-"),
  );
  const statePath = join(directory, "shared-state");
  const administrationKey = randomUUID();
  const apiKey = randomUUID();
  const ingestionEnv = join(directory, "ingestion.env");
  const apiEnv = join(directory, "api.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const planPath = join(directory, "digimon-source-plan.json");
  const failurePlans = [
    ["missing-category", "source_parse_failed"],
    ["canonical-conflict", "printing_reconciliation_blocked"],
    ["unrepresentable-rules", "source_parse_failed"],
  ].map(([scenario, expectedFailureCode]) => ({
    scenario,
    expectedFailureCode,
    path: join(directory, `digimon-${scenario}-plan.json`),
  }));
  await Promise.all([
    writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\nADMINISTRATION_CLOCK_MODE=request\n`,
      { mode: 0o600 },
    ),
    writeFile(apiEnv, `API_BEARER_KEY=${apiKey}\n`, { mode: 0o600 }),
    writeFile(
      planPath,
      JSON.stringify(digimonPlan("complete")),
      { mode: 0o600 },
    ),
    ...failurePlans.map(({ path, scenario }) =>
      writeFile(
        path,
        JSON.stringify(digimonPlan(`complete-${scenario}`)),
        { mode: 0o600 },
      )
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
    service: "card-keepr-synthetic-official-source",
  }];
  await writeFile(ingestionConfig, JSON.stringify(config));

  const source = startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    inspectorPort: 29_229,
    port: sourcePort,
    statePath: join(directory, "source-state"),
  });
  let ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 29_230,
    port: ingestionPort,
    statePath,
  });
  let api = null;
  t.after(async () => {
    await Promise.all([
      stopWorker(source),
      stopWorker(ingestion),
      api === null ? Promise.resolve() : stopWorker(api),
    ]);
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

  for (const { scenario, path, expectedFailureCode } of failurePlans) {
    const failedCollection = await runCli(
      [
        "source",
        "collect",
        "--plan-file",
        path,
        "--idempotency-key",
        `digimon-${scenario}-collect`,
        "--json",
      ],
      cliEnvironment,
    );
    assert.equal(failedCollection.code, 0, failedCollection.stderr);
    const failedRun = JSON.parse(failedCollection.stdout);
    const failedResume = await runCli(
      ["source", "resume", "--run-id", failedRun.id, "--json"],
      cliEnvironment,
    );
    assert.equal(failedResume.code, 0, failedResume.stderr);
    const failure = await waitForRunState(
      failedRun.id,
      "failed",
      cliEnvironment,
      ingestion,
    );
    assert.equal(
      failure.failure_code,
      expectedFailureCode,
      `${scenario} must fail closed at its expected boundary`,
    );
  }

  const collected = await runCli(
    [
      "source",
      "collect",
      "--plan-file",
      planPath,
      "--idempotency-key",
      "digimon-complete-collect",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(collected.code, 0, collected.stderr);
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(
    ["source", "resume", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(resumed.code, 0, resumed.stderr);
  const completed = await waitForRunState(
    run.id,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
  );
  const cardListSnapshots = completed.snapshots
    .map(({ request }) => request.url)
    .filter((url) => url.includes("/cards/index.php"));
  assert.ok(
    cardListSnapshots.some((url) =>
      new URL(url).searchParams.get("category") === "booster"
    ),
    "the current Digimon Version/category must have its own retained request",
  );
  assert.ok(
    cardListSnapshots.some((url) => {
      const parameters = new URL(url).searchParams;
      return parameters.get("category") === "booster" &&
        parameters.get("cardcategory") === "digimon" &&
        parameters.get("colour") === "blue";
    }),
    "a capped category must close over a Card Type and Colour leaf",
  );

  const inspected = await runCli(
    ["candidate", "inspect", "--run-id", run.id, "--json"],
    cliEnvironment,
  );
  assert.equal(inspected.code, 0, inspected.stderr);
  const inspection = JSON.parse(inspected.stdout);
  assert.equal(inspection.diff.summary.cards_added, 1);
  assert.equal(inspection.diff.summary.printings_added, 2);
  assert.ok(
    inspection.diff.warnings.some(
      ({ code, raw_value }) =>
        code === "unknown_source_field" &&
        raw_value === "Retain this future mechanic verbatim",
    ),
    "unknown labelled mechanics must remain visible for schema review",
  );
  assert.ok(
    inspection.diff.warnings.some(
      ({ code }) => code === "product_relationship_unresolved",
    ),
    "a fuzzy Product label must remain unresolved",
  );

  const approved = await runCli(
    [
      "run",
      "approve",
      "--run-id",
      run.id,
      "--candidate-digest",
      inspection.candidate_digest,
      "--expected-current-revision",
      "catrev_spine_000",
      "--idempotency-key",
      "digimon-complete-approve",
      "--yes",
      "--json",
    ],
    cliEnvironment,
  );
  assert.equal(
    approved.code,
    0,
    `${approved.stdout}\n${approved.stderr}\n${ingestion.getOutput()}`,
  );
  const revisionId = JSON.parse(approved.stdout).resulting_revision_id;
  await stopWorker(ingestion);

  api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 29_231,
    port: apiPort,
    statePath,
  });
  await waitForHealth(
    `http://127.0.0.1:${apiPort}/health`,
    apiKey,
    api,
  );
  const headers = { authorization: `Bearer ${apiKey}` };
  const cardsResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/cards?game=digimon&card_number=BT99-001`,
    { headers },
  );
  assert.equal(cardsResponse.status, 200);
  const cardsDocument = await cardsResponse.json();
  assert.equal(cardsDocument.data.length, 1);
  const detailResponse = await fetch(
    `http://127.0.0.1:${apiPort}/v1/cards/${cardsDocument.data[0].id}?include=printings`,
    { headers },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.data.name, "Synthetic Base Digimon");
  assert.deepEqual(detail.data.game_data, {
    profile: "digimon@1",
    attributes: {
      card_type: "digimon",
      colours: ["blue", "red"],
      level: 6,
      play_cost: 11,
      use_cost: null,
      dp: 12000,
      form: "Mega",
      attribute: "Vaccine",
      traits: ["Synthetic Dragon"],
      digivolution_requirements: [{
        index: 1,
        from_level: 5,
        colours: ["blue"],
        cost: 4,
        raw_condition: "Blue Lv.5: 4",
      }],
      text_sections: [
        { kind: "effect", text: "Synthetic main effect." },
        { kind: "inherited_effect", text: "Synthetic inherited effect." },
        { kind: "security_effect", text: "Synthetic security effect." },
        { kind: "dual_effect", text: "Synthetic dual effect." },
        { kind: "dual_rule", text: "Synthetic dual rule." },
        { kind: "link_condition", text: "Synthetic link condition." },
        { kind: "link_effect", text: "Synthetic link effect." },
        {
          kind: "special_digivolution_condition",
          text: "Synthetic special digivolution condition.",
        },
      ],
      dual_colours: ["blue", "red"],
      dual_cost: 7,
      link_dp: 3000,
    },
  });
  assert.deepEqual(
    detail.included.map(({ game_data }) =>
      game_data.attributes.alternative_art
    ).sort(),
    [false, true],
  );

  const [cards, printings, relationships] = await Promise.all(
    ["cards", "printings", "relationships"].map((component) =>
      exportRecords(apiPort, apiKey, revisionId, component)
    ),
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].game_data.profile, "digimon@1");
  assert.equal(printings.length, 2);
  assert.deepEqual(
    printings.map(({ game_data }) =>
      game_data.attributes.alternative_art
    ).sort(),
    [false, true],
  );
  assert.equal(
    relationships.filter(({ kind }) => kind === "printing-product").length,
    2,
    "only the explicit Product evidence should publish",
  );
});

function digimonPlan(marker) {
  return {
    plans: [{
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@3",
      requests: [{
        id: "digimon-en:discovery",
        url: "https://world.digimoncard.com/cards/index.php?search=true",
        headers: {
          accept: `text/html; card-keepr-digimon-scenario=card-keepr-acceptance-digimon/${marker}`,
          "user-agent": `card-keepr-acceptance-digimon/${marker}`,
        },
      }],
    }],
  };
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
    { ...processEnvironment(statePath), CI: "1" },
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

async function waitForRunState(runId, expectedState, environment, worker) {
  const deadline = Date.now() + 30_000;
  let lastDocument = null;
  while (Date.now() < deadline) {
    const shown = await runCli(
      ["source", "show", "--run-id", runId, "--json"],
      environment,
    );
    if (shown.code === 0) {
      lastDocument = JSON.parse(shown.stdout);
      if (lastDocument.state === expectedState) return lastDocument;
      if (lastDocument.state === "failed") {
        const inspected = await runCli(
          ["candidate", "inspect", "--run-id", runId, "--json"],
          environment,
        );
        lastDocument.candidate_inspection = inspected.code === 0
          ? JSON.parse(inspected.stdout)
          : { code: inspected.code, stdout: inspected.stdout };
        break;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const summary = lastDocument === null
    ? null
    : {
        state: lastDocument.state,
        failure_code: lastDocument.failure_code,
        failure_detail: lastDocument.failure_detail,
        warnings: lastDocument.warnings,
        snapshot_urls: lastDocument.snapshots?.map((snapshot) =>
          snapshot.request?.url
        ),
        candidate_inspection: lastDocument.candidate_inspection,
      };
  throw new Error(
    `Run did not reach ${expectedState}: ${JSON.stringify(summary)}\n` +
      worker.getOutput(),
  );
}

async function waitForHealth(url, key, worker) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) throw new Error(worker.getOutput());
    try {
      const response = await fetch(url, {
        headers: key === "" ? {} : { authorization: `Bearer ${key}` },
      });
      if (response.ok) return;
    } catch {
      // Wrangler has not started accepting requests yet.
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
