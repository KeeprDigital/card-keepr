import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const apiPort = 26_787;
const ingestionPort = 26_788;
const sourcePort = 26_789;

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
const rawSourcePayloadMarkers = [
  "Synthetic Leader",
  "ONE PIECE CARD LIST",
  "Synthetic Set [OP99]",
];

test("operational logs and diagnostics retain correlation fields without leaking secrets or source payloads", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "card-keepr-diagnostics-leak-"),
  );
  const secrets = {
    API_BEARER_KEY: `api-bearer-secret-${randomUUID()}`,
    ADMINISTRATION_KEY: `administration-secret-${randomUUID()}`,
    D1_VERIFICATION_TOKEN: `d1-verification-secret-${randomUUID()}`,
    CREDENTIAL_BOUNDARY_ATTESTATION_KEY: `attestation-secret-${randomUUID()}`,
    CREDENTIAL_CONSUMER_PROOF_KEY: `consumer-proof-secret-${randomUUID()}`,
    CLOUDFLARE_OBSERVATION_TOKEN: `observation-token-secret-${randomUUID()}`,
    GITHUB_APP_PRIVATE_KEY: `github-app-private-secret-${randomUUID()}`,
  };
  const forgedApiToken = `forged-api-bearer-${randomUUID()}`;
  const forgedAdministrationToken = `forged-administration-${randomUUID()}`;
  const apiEnv = join(directory, "api.env");
  const ingestionEnv = join(directory, "ingestion.env");
  const ingestionConfig = join(directory, "ingestion.wrangler.json");
  const apiState = join(directory, "api-state");
  const ingestionState = join(directory, "ingestion-state");
  const sourceState = join(directory, "source-state");
  await writeFile(
    apiEnv,
    `API_BEARER_KEY=${secrets.API_BEARER_KEY}\n` +
      `CREDENTIAL_CONSUMER_PROOF_KEY=${secrets.CREDENTIAL_CONSUMER_PROOF_KEY}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    ingestionEnv,
    Object.entries(secrets)
      .filter(([name]) => name !== "API_BEARER_KEY")
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
    { mode: 0o600 },
  );
  const config = JSON.parse(
    readFileSync(resolve(root, "apps/ingestion/wrangler.jsonc"), "utf8"),
  );
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
  await Promise.all([applyMigrations(apiState), applyMigrations(ingestionState)]);

  const api = startWorker({
    config: "apps/api/wrangler.jsonc",
    envFile: apiEnv,
    inspectorPort: 26_887,
    port: apiPort,
    statePath: apiState,
  });
  const ingestion = startWorker({
    config: ingestionConfig,
    envFile: ingestionEnv,
    inspectorPort: 26_888,
    port: ingestionPort,
    statePath: ingestionState,
  });
  const source = startWorker({
    config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
    inspectorPort: 26_889,
    port: sourcePort,
    statePath: sourceState,
  });
  t.after(async () => {
    await Promise.all([
      stopWorker(api),
      stopWorker(ingestion),
      stopWorker(source),
    ]);
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([
    waitForHealth(
      `http://127.0.0.1:${apiPort}/health`,
      secrets.API_BEARER_KEY,
      api,
    ),
    waitForHealth(
      `http://127.0.0.1:${ingestionPort}/health`,
      secrets.ADMINISTRATION_KEY,
      ingestion,
    ),
    waitForHealth(
      `http://127.0.0.1:${sourcePort}/success`,
      "no-credential-required",
      source,
    ),
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
    await fetch(`http://127.0.0.1:${apiPort}/v1/catalogue`, {
      headers: { authorization: `Bearer ${forgedApiToken}` },
    }),
  );
  assert.equal(apiRejection.status, 401);
  assert.equal(apiRejection.body.code, "invalid_api_key");
  assert.match(apiRejection.body.request_id, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

  const ingestionRejection = await capture(
    "ingestion auth-failure response",
    await fetch(`http://127.0.0.1:${ingestionPort}/v1/status`, {
      headers: { authorization: `Bearer ${forgedAdministrationToken}` },
    }),
  );
  assert.equal(ingestionRejection.status, 401);
  assert.equal(ingestionRejection.body.code, "invalid_administration_key");
  assert.match(
    ingestionRejection.body.request_id,
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  );

  // 2. A failing evidence-backed Ingestion Run that retains real source
  //    snapshot bytes before failing to parse (declared pagination mismatch).
  const administrationHeaders = {
    authorization: `Bearer ${secrets.ADMINISTRATION_KEY}`,
    "content-type": "application/json",
  };
  const started = await capture(
    "evidence run creation response",
    await fetch(`http://127.0.0.1:${ingestionPort}/v1/ingestion-runs/evidence`, {
      method: "POST",
      headers: administrationHeaders,
      body: JSON.stringify({
        plans: [
          {
            supported_game: "one-piece",
            source_lineage: "one-piece-en",
            adapter_version: "one-piece-en@3",
            requests: [
              {
                id: "one-piece-en:discovery",
                url: "https://en.onepiece-cardgame.com/cardlist/",
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
    await fetch(
      `http://127.0.0.1:${ingestionPort}/v1/ingestion-runs/${
        encodeURIComponent(runId)
      }/collection/resume`,
      { method: "POST", headers: administrationHeaders },
    ),
  );
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));

  const failedRun = await waitForFailedRun(
    `http://127.0.0.1:${ingestionPort}/v1/ingestion-runs/${
      encodeURIComponent(runId)
    }`,
    secrets.ADMINISTRATION_KEY,
    ingestion,
    capturedResponses,
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
  assert.equal(
    diagnostics.terminal_evidence.coverage.source_snapshot_count,
    failedRun.snapshots.length,
  );

  // 3. Status diagnostics over HTTP and the CLI.
  const status = await capture(
    "status response",
    await fetch(`http://127.0.0.1:${ingestionPort}/v1/status`, {
      headers: { authorization: `Bearer ${secrets.ADMINISTRATION_KEY}` },
    }),
  );
  assert.equal(status.status, 200);
  const cliStatus = await runCli(["status", "--json"], {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${ingestionPort}`,
    KEEPR_ADMINISTRATION_KEY: secrets.ADMINISTRATION_KEY,
  });
  assert.equal(cliStatus.code, 0, cliStatus.stderr);
  capturedResponses.push(
    { label: "CLI status stdout", text: cliStatus.stdout },
    { label: "CLI status stderr", text: cliStatus.stderr },
  );

  // Stop the Workers so the wrangler debug logs (which retain Worker console
  // output even at --log-level error) are complete, then sweep everything.
  await Promise.all([
    stopWorker(api),
    stopWorker(ingestion),
    stopWorker(source),
  ]);
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
      assert.ok(
        !channel.text.includes(secret.value),
        `${secret.name} leaked into ${channel.label}`,
      );
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
    .filter((line) =>
      line.startsWith("{") &&
      line.includes('"contract":"card-keepr-operational-log@1"')
    )
    .map((line) => JSON.parse(line));
  assert.ok(operationalEvents.length >= 3);
  for (const event of operationalEvents) {
    assert.ok(
      JSON.stringify(event).length < 2_048,
      `operational log event is too large to be metadata-only: ${
        JSON.stringify(event).slice(0, 200)
      }`,
    );
    if (event.event === "workflow.failed") {
      assert.deepEqual(
        Object.keys(event).sort(),
        [...workflowFailureEventKeys].sort(),
      );
      continue;
    }
    assert.ok(
      ["request.completed", "workflow.step.completed"].includes(event.event),
      `unexpected operational log event: ${event.event}`,
    );
    assert.deepEqual(Object.keys(event).sort(), [...requestEventKeys].sort());
    assert.deepEqual(
      Object.keys(event.request).sort(),
      ["id", "method", "route"],
    );
    assert.equal(typeof event.status, "number");
  }

  const requestEvent = (requestId) =>
    operationalEvents.find(
      (event) =>
        event.event === "request.completed" && event.request.id === requestId,
    );
  const apiRejectionEvent = requestEvent(apiRejection.body.request_id);
  assert.ok(apiRejectionEvent, "the API auth failure was logged");
  assert.equal(apiRejectionEvent.runtime, "api");
  assert.equal(apiRejectionEvent.request.route, "/v1/catalogue");
  assert.equal(apiRejectionEvent.status, 401);

  const ingestionRejectionEvent = requestEvent(
    ingestionRejection.body.request_id,
  );
  assert.ok(ingestionRejectionEvent, "the ingestion auth failure was logged");
  assert.equal(ingestionRejectionEvent.runtime, "ingestion");
  assert.equal(ingestionRejectionEvent.request.route, "/v1/status");
  assert.equal(ingestionRejectionEvent.status, 401);

  const creationEvent = requestEvent(diagnostics.references.request_id);
  assert.ok(
    creationEvent,
    "the retained operational request id correlates with a logged request",
  );
  assert.equal(creationEvent.request.method, "POST");
  assert.equal(creationEvent.request.route, "/v1/ingestion-runs/evidence");
  assert.equal(creationEvent.status, 201);
});

async function waitForFailedRun(url, key, worker, capturedResponses) {
  const deadline = Date.now() + 120_000;
  let lastBody = null;
  while (Date.now() < deadline) {
    if (worker.process.exitCode !== null) throw new Error(worker.getOutput());
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
    });
    const text = await response.text();
    if (response.status === 200) {
      lastBody = text;
      const document = JSON.parse(text);
      if (document.state === "failed") {
        capturedResponses.push({
          label: "terminal evidence run show response",
          text,
        });
        return document;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(
    `the evidence run did not reach a terminal failure: ${lastBody}\n${worker.getOutput()}`,
  );
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
