import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForResponse,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");

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

  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: join(directory, "source-state"),
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath: join(directory, "ingestion-state"),
    migrate: true,
  });
  t.after(async () => {
    await Promise.all([stopWorker(source), stopWorker(ingestion)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForResponse(
      `${source.url}/success`,
      source,
      "synthetic Official Source",
    ),
    waitForResponse(
      `${ingestion.url}/health`,
      ingestion,
      "ingestion Worker",
      { authorization: `Bearer ${administrationKey}` },
    ),
  ]);

  const cliEnvironment = {
    KEEPR_ADMINISTRATION_KEY: administrationKey,
    KEEPR_INGESTION_URL: ingestion.url,
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
  assert.equal(rejected.snapshots.length, 0);
  assert.equal(rejected.observation_sets.length, 0);
  assert.equal(rejected.diagnostics.length, 1);
  assert.equal(
    rejected.diagnostics.find(
      ({ request_id }) => request_id === "one-piece-en:discovery",
    )?.outcome,
    "redirect",
  );

  // Exhausting the retryable 503 responses pauses the same Ingestion Run
  // instead of failing it. `keepr source resume` then opens the next bounded
  // retry generation and the identical run completes collection.
  const paused = await collectResumeAndShow(
    "cli_retry_pause_evidence_001",
    "unavailable-then-recovered",
    "paused",
    cliEnvironment,
    ingestion,
    directory,
  );
  assert.equal(paused.failure_code, null);
  assert.equal(paused.pause.reason, "source_transport_retries_exhausted");
  assert.equal(paused.pause.request_id, "one-piece-en:discovery");
  assert.equal(paused.pause.hostname, "en.onepiece-cardgame.com");
  assert.equal(paused.pause.retry_generation, 1);
  assert.equal(paused.pause.attempt_count, 4);
  assert.equal(paused.pause.failure_classification, "http_failure");
  assert.equal(paused.pause.http_status, 503);
  assert.deepEqual(paused.pause.actions, ["resume", "terminate"]);
  assert.deepEqual(paused.actions, ["resume", "terminate"]);
  assert.equal(paused.snapshots.length, 0);
  assert.equal(paused.observation_sets.length, 0);
  assert.equal(paused.diagnostics.length, 4);
  for (const diagnostic of paused.diagnostics) {
    assert.equal(diagnostic.outcome, "http_failure");
    assert.equal(diagnostic.http_status, 503);
  }

  const resumedAfterPause = await runCli(
    ["source", "resume", "--run-id", paused.id, "--json"],
    cliEnvironment,
  );
  assert.equal(resumedAfterPause.code, 0, resumedAfterPause.stderr);
  const successful = await waitForRunState(
    paused.id,
    "awaiting_approval",
    cliEnvironment,
    ingestion,
    { deadlineMs: 30_000 },
  );
  assert.equal(successful.failure_code, null);
  assert.equal(successful.id, paused.id);
  // The recovered fetch is attempt 5 of the same append-only history.
  const discoveryAttempts = successful.diagnostics.filter(
    ({ request_id }) => request_id === "one-piece-en:discovery",
  );
  assert.deepEqual(
    discoveryAttempts.map(({ attempt_number, outcome }) => ({
      attempt_number,
      outcome,
    })),
    [
      { attempt_number: 1, outcome: "http_failure" },
      { attempt_number: 2, outcome: "http_failure" },
      { attempt_number: 3, outcome: "http_failure" },
      { attempt_number: 4, outcome: "http_failure" },
      { attempt_number: 5, outcome: "success" },
    ],
  );
  assert.deepEqual(
    successful.snapshots.map(({ request }) => request.url),
    [
      "https://en.onepiece-cardgame.com/cardlist/?series=569116",
      "https://en.onepiece-cardgame.com/cardlist/?series=569116",
      "https://en.onepiece-cardgame.com/products/",
      "https://en.onepiece-cardgame.com/rules/",
      "https://en.onepiece-cardgame.com/cardlist/?series=569116",
      "https://en.onepiece-cardgame.com/products/",
      "https://en.onepiece-cardgame.com/products/",
      "https://en.onepiece-cardgame.com/news/restriction.html",
      "https://en.onepiece-cardgame.com/topics/013.php",
      "https://en.onepiece-cardgame.com/rules/errata_card/",
      "https://en.onepiece-cardgame.com/rules/",
      "https://en.onepiece-cardgame.com/images/OP99-001.png",
    ],
  );
  assert.equal(
    successful.observation_sets.length,
    successful.snapshots.length,
  );
  // Every snapshot has its successful attempt, plus the four retained 503
  // diagnostics from the paused generation.
  assert.equal(
    successful.diagnostics.length,
    successful.snapshots.length + 4,
  );
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
        adapter_version: "one-piece-en@6",
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

  return waitForRunState(run.id, expectedState, environment, ingestion, {
    deadlineMs: 20_000,
  });
}

function exactOnePieceRequests() {
  return [{
    id: "one-piece-en:discovery",
    url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  }];
}
