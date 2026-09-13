import { readWorkerConfig } from "../cli/lib/config.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  administrationPollInterval,
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");

// Every request-scoped operational log event must carry exactly these fields:
// correlation and health metadata, and nothing else (no payloads, no
// credentials, no consumer identity).
const requestEventKeys = [
  "contract",
  "event",
  "runtime",
  "request",
  "status",
  "duration_ms",
  "workflow",
  "retry",
  "cache",
  "d1",
];
const workflowFailureEventKeys = [
  "contract",
  "event",
  "runtime",
  "failure_code",
  "request_id",
  "workflow_step",
  "catalogue_revision_id",
  "retry_count",
  "retry_classification",
];

// Distinctive substrings of the synthetic Official Source card-list body.
// Snapshot bytes are retained in R2 only; none of them may surface in
// operational logs or diagnostics responses.
const rawSourcePayloadMarkers = ["Synthetic Leader", "ONE PIECE CARD LIST", "Synthetic Set [OP99]"];

test("operational logs and diagnostics retain correlation fields without leaking secrets or source payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "card-keepr-diagnostics-leak-"));
  const secrets = {
    API_BEARER_KEY: `api-bearer-secret-${randomUUID()}`,
    ADMINISTRATION_KEY: `administration-secret-${randomUUID()}`,
    D1_VERIFICATION_TOKEN: `d1-verification-secret-${randomUUID()}`,
  };
  const forgedApiToken = `forged-api-bearer-${randomUUID()}`;
  const forgedAdministrationToken = `forged-administration-${randomUUID()}`;
  const apiEnv = join(directory, "api.env");
  const ingestionEnv = join(directory, "ingestion.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const apiState = join(directory, "api-state");
  const ingestionState = join(directory, "ingestion-state");
  const sourceState = join(directory, "source-state");
  await writeFile(apiEnv, `API_BEARER_KEY=${secrets.API_BEARER_KEY}\n`, { mode: 0o600 });
  await writeFile(
    ingestionEnv,
    Object.entries(secrets)
      .filter(([name]) => name !== "API_BEARER_KEY")
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const config = await readWorkerConfig(resolve(root, "apps/ingestion/wrangler.jsonc"));
  delete config.$schema;
  config.main = resolve(root, "apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve(root, "migrations");
  config.ratelimits[0].simple.limit = 300;
  config.services = [
    {
      binding: "OFFICIAL_SOURCE_TRANSPORT",
      service: "card-keepr-synthetic-official-source",
    },
  ];
  await writeFile(ingestionConfig, JSON.stringify(config));
  // Cold Miniflare instances share persistence metadata even with distinct D1
  // IDs. Close the first migration runtime before opening the second one.
  await applyMigrations(apiState);
  await applyMigrations(ingestionState);

  const api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    statePath: apiState,
  });
  const ingestion = await startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    statePath: ingestionState,
  });
  const source = await startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    statePath: sourceState,
  });
  t.after(async () => {
    await Promise.all([stopWorker(api), stopWorker(ingestion), stopWorker(source)]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(`${api.url}/health`, secrets.API_BEARER_KEY, api),
    waitForHealth(`${ingestion.url}/health`, secrets.ADMINISTRATION_KEY, ingestion),
    waitForHealth(`${source.url}/success`, "no-credential-required", source),
  ]);

  const capturedResponses = [];
  const capture = async (label, response) => {
    const body = await response.text();
    capturedResponses.push({ label, text: body });
    return { status: response.status, body: JSON.parse(body) };
  };

  // 1. Authentication failures on both runtimes with forged bearer tokens.
  const apiRejection = await capture(
    "API auth-failure response",
    await fetch(`${api.url}/v1/catalogue`, {
      headers: { authorization: `Bearer ${forgedApiToken}` },
    }),
  );
  assert.equal(apiRejection.status, 401);
  assert.equal(apiRejection.body.code, "invalid_api_key");
  assert.match(apiRejection.body.request_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

  const ingestionRejection = await capture(
    "ingestion auth-failure response",
    await fetch(`${ingestion.url}/v1/status`, {
      headers: { authorization: `Bearer ${forgedAdministrationToken}` },
    }),
  );
  assert.equal(ingestionRejection.status, 401);
  assert.equal(ingestionRejection.body.code, "invalid_administration_key");
  assert.match(ingestionRejection.body.request_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

  // 2. A failing evidence-backed Ingestion Run that retains real source
  //    snapshot bytes before failing to parse (declared pagination mismatch).
  const administrationHeaders = {
    authorization: `Bearer ${secrets.ADMINISTRATION_KEY}`,
    "content-type": "application/json",
  };
  const started = await capture(
    "evidence run creation response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/evidence`, {
      method: "POST",
      headers: administrationHeaders,
      body: JSON.stringify({
        plans: [
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "one-piece-en@6",
            requests: [
              {
                id: "one-piece-en:discovery",
                url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
                headers: {
                  "user-agent": "card-keepr-acceptance-parser/pagination",
                },
              },
            ],
          },
        ],
        idempotency_key: "operational-diagnostics-leak-001",
      }),
    }),
  );
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const runId = started.body.id;
  const resumed = await capture(
    "evidence run resume response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(runId)}/collection/resume`, {
      method: "POST",
      headers: administrationHeaders,
    }),
  );
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));

  const failedRun = await waitForRunState(
    `${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(runId)}`,
    secrets.ADMINISTRATION_KEY,
    ingestion,
    capturedResponses,
    "failed",
    "terminal evidence run show response",
  );
  assert.equal(failedRun.failure_code, "source_parse_failed");
  assert.ok(failedRun.snapshots.length >= 1);
  for (const snapshot of failedRun.snapshots) {
    assert.deepEqual(
      Object.keys(snapshot.content).sort(),
      ["byte_length", "digest", "media_type", "object_key"],
      "retained snapshots expose content metadata only, never bytes",
    );
    assert.ok(snapshot.content.byte_length > 0);
  }
  const diagnostics = failedRun.operational_diagnostics;
  assert.equal(diagnostics.contract, "card-keepr-operational-diagnostics@1");
  assert.equal(diagnostics.references.run_id, runId);
  assert.match(
    diagnostics.references.request_id,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "the terminal run retains its creating operational request id",
  );
  assert.equal(diagnostics.retry_available, true);
  assert.equal(diagnostics.retry.code, "evidence_collection_retry_available");
  assert.equal(diagnostics.terminal_evidence.coverage.source_snapshot_count, failedRun.snapshots.length);

  // 3. A paused, inspected, then deliberately terminated collection: the
  //    pause facts, the aggregated collection inspection, the termination
  //    document, and the terminal inspection all pass through the sweep.
  const pausedStart = await capture(
    "paused evidence run creation response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/evidence`, {
      method: "POST",
      headers: administrationHeaders,
      body: JSON.stringify({
        plans: [
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "one-piece-en@6",
            requests: [
              {
                id: "one-piece-en:discovery",
                url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
                headers: {
                  "user-agent": "card-keepr-acceptance-transport/unavailable",
                },
              },
            ],
          },
        ],
        idempotency_key: "operational-diagnostics-leak-paused-001",
      }),
    }),
  );
  assert.equal(pausedStart.status, 201, JSON.stringify(pausedStart.body));
  const pausedRunId = pausedStart.body.id;
  const pausedResume = await capture(
    "paused evidence run resume response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(pausedRunId)}/collection/resume`, {
      method: "POST",
      headers: administrationHeaders,
    }),
  );
  assert.equal(pausedResume.status, 202, JSON.stringify(pausedResume.body));
  const pausedRun = await waitForRunState(
    `${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(pausedRunId)}`,
    secrets.ADMINISTRATION_KEY,
    ingestion,
    capturedResponses,
    "paused",
    "paused evidence run show response",
  );
  assert.equal(pausedRun.pause.reason, "source_transport_retries_exhausted");
  assert.deepEqual(pausedRun.actions, ["resume", "terminate"]);
  assert.equal(pausedRun.collection.pause_reason, "source_transport_retries_exhausted");
  assert.equal(pausedRun.collection.evidence.fetch_attempt_count, 4);
  assert.equal(pausedRun.collection.progress.current_request.hostname, "en.onepiece-cardgame.com");
  assert.ok(Array.isArray(pausedRun.collection.pacing.hosts));
  assert.equal(pausedRun.collection.estimate.advisory, true);
  for (const attempt of pausedRun.workflow.attempts) {
    assert.match(attempt.status, /^[a-z_]+$/);
  }
  const cliPaused = await runCli(["source", "show", "--run-id", pausedRunId], {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: secrets.ADMINISTRATION_KEY,
  });
  assert.equal(cliPaused.code, 0, cliPaused.stderr);
  capturedResponses.push(
    { label: "CLI paused source show stdout", text: cliPaused.stdout },
    { label: "CLI paused source show stderr", text: cliPaused.stderr },
  );
  const termination = await capture(
    "collection termination response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(pausedRunId)}/collection/termination`, {
      method: "POST",
      headers: administrationHeaders,
      body: JSON.stringify({
        idempotency_key: "operational-diagnostics-leak-terminate-001",
      }),
    }),
  );
  assert.equal(termination.status, 200, JSON.stringify(termination.body));
  assert.equal(termination.body.failure_code, "ingestion_run_terminated");
  const terminatedRun = await capture(
    "terminated evidence run show response",
    await fetch(`${ingestion.url}/v1/ingestion-runs/${encodeURIComponent(pausedRunId)}`, {
      headers: { authorization: `Bearer ${secrets.ADMINISTRATION_KEY}` },
    }),
  );
  assert.equal(terminatedRun.status, 200);
  assert.equal(terminatedRun.body.state, "failed");
  assert.equal(terminatedRun.body.termination.pause_reason, "source_transport_retries_exhausted");
  assert.deepEqual(terminatedRun.body.actions, ["retry"]);
  assert.equal(terminatedRun.body.operational_diagnostics.terminal_evidence.failure.code, "ingestion_run_terminated");

  // 4. Liveness and readiness documents (issue #144) on both runtimes:
  //    liveness carries exactly status and runtime; readiness carries the
  //    binding checks and passes through the same sweep as every other
  //    diagnostic surface, as does the CLI rendering of it.
  for (const [runtime, worker] of [
    ["api", api],
    ["ingestion", ingestion],
  ]) {
    const liveness = await capture(`${runtime} liveness response`, await fetch(`${worker.url}/healthz`));
    assert.equal(liveness.status, 200);
    assert.deepEqual(liveness.body, { status: "ok", runtime });
    const anonymousReadiness = await capture(
      `${runtime} unauthenticated readiness response`,
      await fetch(`${worker.url}/health`),
    );
    assert.equal(anonymousReadiness.status, 401);
  }
  const apiReadiness = await capture(
    "API readiness response",
    await fetch(`${api.url}/health`, {
      headers: { authorization: `Bearer ${secrets.API_BEARER_KEY}` },
    }),
  );
  assert.equal(apiReadiness.status, 200);
  assert.equal(apiReadiness.body.status, "ok");
  assert.deepEqual(Object.keys(apiReadiness.body.checks).sort(), ["database", "objects", "public_base", "version"]);
  const ingestionReadiness = await capture(
    "ingestion readiness response",
    await fetch(`${ingestion.url}/health`, {
      headers: { authorization: `Bearer ${secrets.ADMINISTRATION_KEY}` },
    }),
  );
  assert.equal(ingestionReadiness.status, 200);
  assert.equal(ingestionReadiness.body.status, "ok");
  assert.deepEqual(Object.keys(ingestionReadiness.body.checks).sort(), [
    "database",
    "objects",
    "public_base",
    "version",
    "workflows",
  ]);
  for (const document of [apiReadiness.body, ingestionReadiness.body]) {
    for (const check of Object.values(document.checks)) {
      assert.equal(check.status, "pass", JSON.stringify(check));
    }
  }
  const cliHealth = await runCli(["health", "--json"], {
    KEEPR_API_URL: api.url,
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_API_KEY: secrets.API_BEARER_KEY,
    KEEPR_ADMINISTRATION_KEY: secrets.ADMINISTRATION_KEY,
  });
  assert.equal(cliHealth.code, 0, cliHealth.stderr);
  capturedResponses.push(
    { label: "CLI health stdout", text: cliHealth.stdout },
    { label: "CLI health stderr", text: cliHealth.stderr },
  );

  // 5. Status diagnostics over HTTP and the CLI.
  const status = await capture(
    "status response",
    await fetch(`${ingestion.url}/v1/status`, {
      headers: { authorization: `Bearer ${secrets.ADMINISTRATION_KEY}` },
    }),
  );
  assert.equal(status.status, 200);
  const cliStatus = await runCli(["status", "--json"], {
    KEEPR_INGESTION_URL: ingestion.url,
    KEEPR_ADMINISTRATION_KEY: secrets.ADMINISTRATION_KEY,
  });
  assert.equal(cliStatus.code, 0, cliStatus.stderr);
  capturedResponses.push(
    { label: "CLI status stdout", text: cliStatus.stdout },
    { label: "CLI status stderr", text: cliStatus.stderr },
  );

  // Stop the Workers so the wrangler debug logs (which retain Worker console
  // output even at --log-level error) are complete, then sweep everything.
  await Promise.all([stopWorker(api), stopWorker(ingestion), stopWorker(source)]);
  const channels = [
    { label: "API worker console output", text: api.getOutput() },
    { label: "ingestion worker console output", text: ingestion.getOutput() },
    { label: "source worker console output", text: source.getOutput() },
    ...(await wranglerLogChannels(apiState)),
    ...(await wranglerLogChannels(ingestionState)),
    ...(await wranglerLogChannels(sourceState)),
    ...capturedResponses,
  ];

  const secretValues = [
    ...Object.entries(secrets).map(([name, value]) => ({
      name: `configured secret ${name}`,
      value,
    })),
    { name: "forged API bearer token", value: forgedApiToken },
    {
      name: "forged administration bearer token",
      value: forgedAdministrationToken,
    },
  ];
  for (const channel of channels) {
    for (const secret of secretValues) {
      assert.ok(!channel.text.includes(secret.value), `${secret.name} leaked into ${channel.label}`);
    }
    for (const marker of rawSourcePayloadMarkers) {
      assert.ok(
        !channel.text.includes(marker),
        `raw Official Source payload ("${marker}") leaked into ${channel.label}`,
      );
    }
  }

  // Operational log events retain correlation fields with a closed shape.
  const operationalEvents = channels
    .flatMap(({ text }) => text.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.includes('"contract":"card-keepr-operational-log@1"'))
    .map((line) => JSON.parse(line));
  assert.ok(operationalEvents.length >= 3);
  for (const event of operationalEvents) {
    assert.ok(
      JSON.stringify(event).length < 2_048,
      `operational log event is too large to be metadata-only: ${JSON.stringify(event).slice(0, 200)}`,
    );
    if (event.event === "workflow.failed") {
      assert.deepEqual(Object.keys(event).sort(), [...workflowFailureEventKeys].sort());
      continue;
    }
    assert.ok(
      ["request.completed", "workflow.step.completed"].includes(event.event),
      `unexpected operational log event: ${event.event}`,
    );
    assert.deepEqual(Object.keys(event).sort(), [...requestEventKeys].sort());
    assert.deepEqual(Object.keys(event.request).sort(), ["id", "method", "route"]);
    assert.equal(typeof event.status, "number");
  }

  // The liveness probe is polled by monitors and stays out of the log.
  assert.equal(
    operationalEvents.some((event) => event.request?.route === "/healthz"),
    false,
    "liveness requests must not be written to the operational log",
  );
  assert.ok(
    operationalEvents.some((event) => event.request?.route === "/health" && event.status === 200),
    "readiness requests are logged like any other authenticated route",
  );

  const requestEvent = (requestId) =>
    operationalEvents.find((event) => event.event === "request.completed" && event.request.id === requestId);
  const apiRejectionEvent = requestEvent(apiRejection.body.request_id);
  assert.ok(apiRejectionEvent, "the API auth failure was logged");
  assert.equal(apiRejectionEvent.runtime, "api");
  assert.equal(apiRejectionEvent.request.route, "/v1/catalogue");
  assert.equal(apiRejectionEvent.status, 401);

  const ingestionRejectionEvent = requestEvent(ingestionRejection.body.request_id);
  assert.ok(ingestionRejectionEvent, "the ingestion auth failure was logged");
  assert.equal(ingestionRejectionEvent.runtime, "ingestion");
  assert.equal(ingestionRejectionEvent.request.route, "/v1/status");
  assert.equal(ingestionRejectionEvent.status, 401);

  const creationEvent = requestEvent(diagnostics.references.request_id);
  assert.ok(creationEvent, "the retained operational request id correlates with a logged request");
  assert.equal(creationEvent.request.method, "POST");
  assert.equal(creationEvent.request.route, "/v1/ingestion-runs/evidence");
  assert.equal(creationEvent.status, 201);
});

async function waitForRunState(url, key, worker, capturedResponses, expectedState, label) {
  const deadline = Date.now() + 120_000;
  let lastBody = null;
  let pollCount = 0;
  while (Date.now() < deadline) {
    pollCount += 1;
    if (worker.closed || (worker.process && worker.process.exitCode !== null)) throw new Error(worker.getOutput());
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.status === 429) {
      throw new Error(
        `ADMINISTRATION_RATE_LIMIT returned HTTP 429 on poll ${pollCount} while waiting for ${expectedState}.`,
      );
    }
    const text = await response.text();
    if (response.status === 200) {
      lastBody = text;
      const document = JSON.parse(text);
      if (document.state === expectedState) {
        capturedResponses.push({ label, text });
        return document;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, administrationPollInterval(worker)));
  }
  throw new Error(`the evidence run did not reach ${expectedState}: ${lastBody}\n${worker.getOutput()}`);
}

async function wranglerLogChannels(statePath) {
  const logsDirectory = join(statePath, "logs");
  const entries = await readdir(logsDirectory).catch(() => []);
  return Promise.all(
    entries.map(async (entry) => ({
      label: `wrangler log ${join(logsDirectory, entry)}`,
      text: await readFile(join(logsDirectory, entry), "utf8"),
    })),
  );
}
