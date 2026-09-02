import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  capturePreparedAttempt,
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import {
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
} from "./runtime-helpers";

installRuntimeSuite();

test("transport retry exhaustion pauses the Ingestion Run without failing the request", async () => {
  const run = await createCollection(
    "retry_pause_transport_001",
    "https://transport-pause-official-source.invalid/unavailable",
  );
  const response = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const paused = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    12_000,
  );

  // Exhausting the bounded transport retries is not proof the Official
  // Source evidence failed: the run pauses non-terminally with its own
  // stable machine-readable reason and the request stays pending.
  expect(paused).toMatchObject({
    state: "paused",
    failure_code: null,
    pause: {
      reason: "source_transport_retries_exhausted",
      paused_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      source_lineage: "one-piece-en",
      request_id: "required-source",
      hostname: "transport-pause-official-source.invalid",
      retry_generation: 1,
      attempt_count: 4,
      failure_classification: "http_failure",
      http_status: 503,
      actions: ["resume"],
    },
    snapshots: [],
  });
  // The pause block has a closed shape: correlation identifiers, bounded
  // counters, and machine codes only, so the diagnostics surface stays free
  // of request headers, payloads, and credentials.
  expect(paused.pause).toEqual({
    reason: "source_transport_retries_exhausted",
    paused_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    source_lineage: "one-piece-en",
    request_id: "required-source",
    hostname: "transport-pause-official-source.invalid",
    retry_generation: 1,
    attempt_count: 4,
    failure_classification: "http_failure",
    http_status: 503,
    actions: ["resume"],
  });
  expect(
    paused.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
      status: diagnostic.http_status,
    })),
  ).toEqual([1, 2, 3, 4].map((attempt) => ({
    attempt_number: attempt,
    outcome: "http_failure",
    status: 503,
  })));

  // The request is not misreported as source failure, and the pause is a
  // recorded lifecycle transition that keeps the active-run reservation.
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, failure_code, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'required-source'`,
  ).bind(run.id).first()).toMatchObject({
    state: "pending",
    failure_code: null,
    retry_generation: 1,
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence DESC LIMIT 1`,
  ).bind(run.id).first()).toMatchObject({
    from_state: "collecting",
    to_state: "paused",
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1`,
  ).first("active_ingestion_run_id")).toBe(run.id);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT * FROM ingestion_run_retry_pauses WHERE ingestion_run_id = ?`,
  ).bind(run.id).first()).toMatchObject({
    request_id: "required-source",
    retry_generation: 1,
    pause_reason: "source_transport_retries_exhausted",
    source_lineage: "one-piece-en",
    hostname: "transport-pause-official-source.invalid",
    attempt_count: 4,
    failure_classification: "http_failure",
    http_status: 503,
  });
});

test("resuming a transport-paused run opens a new bounded retry generation and completes", async () => {
  const run = await createCollection(
    "retry_pause_resume_001",
    "https://recovering-official-source.invalid/unavailable-then-recovered",
  );
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    12_000,
  );

  // Resuming the same Ingestion Run opens generation 2 for the exhausted
  // request under a new deterministic parent Workflow identity. Earlier
  // attempts are neither deleted nor renumbered: the recovered fetch is
  // attempt 5 in the same append-only history.
  const resumedResponse = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumedResponse.status).toBe(202);
  await expect(resumedResponse.json()).resolves.toMatchObject({
    ingestion_run_id: run.id,
    workflow: { id: `evidence-${run.id}-resume-1` },
  });
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "parsing",
    12_000,
  );
  expect(completed).toMatchObject({
    state: "parsing",
    failure_code: null,
    workflow: { parent_id: `evidence-${run.id}-resume-1` },
  });
  expect(completed.pause).toBeUndefined();
  expect(completed.snapshots).toHaveLength(1);
  expect(
    completed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
    })),
  ).toEqual([
    { attempt_number: 1, outcome: "http_failure" },
    { attempt_number: 2, outcome: "http_failure" },
    { attempt_number: 3, outcome: "http_failure" },
    { attempt_number: 4, outcome: "http_failure" },
    { attempt_number: 5, outcome: "success" },
  ]);

  expect(await env.CATALOGUE_DB.prepare(
    `SELECT state, retry_generation FROM source_requests
     WHERE ingestion_run_id = ? AND request_id = 'required-source'`,
  ).bind(run.id).first()).toMatchObject({
    state: "observed",
    retry_generation: 2,
  });
  const transitions = await env.CATALOGUE_DB.prepare(
    `SELECT from_state, to_state FROM ingestion_run_transitions
     WHERE ingestion_run_id = ? ORDER BY sequence`,
  ).bind(run.id).all<{ from_state: string | null; to_state: string }>();
  expect(
    transitions.results.map((row) => `${row.from_state}->${row.to_state}`),
  ).toEqual([
    "null->collecting",
    "collecting->paused",
    "paused->collecting",
    "collecting->parsing",
  ]);
  // The immutable pause record survives the resume as audit history.
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_retry_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(1);
});

test("network failure exhaustion pauses with the network classification", async () => {
  const run = await createCollection(
    "retry_pause_network_001",
    "https://network-pause-official-source.invalid/cards",
  );
  const unreachableTransport = {
    fetch: async () => {
      throw new TypeError("synthetic connection reset");
    },
  } as unknown as Fetcher;
  const evidenceRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const request = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (request === undefined) throw new Error("missing evidence request");
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const prepared = await prepareCaptureAttempt(
      env.CATALOGUE_DB,
      evidenceRun,
      request,
    );
    if (prepared.kind !== "attempt") {
      throw new Error(`unexpected preparation result ${prepared.kind}`);
    }
    const result = await capturePreparedAttempt(
      env.CATALOGUE_DB,
      env.EVIDENCE_OBJECTS,
      unreachableTransport,
      evidenceRun,
      request,
      prepared,
    );
    expect(result.kind).toBe(attempt === 4 ? "done" : "wait");
  }

  const paused = await showCollection(run.id);
  expect(paused).toMatchObject({
    state: "paused",
    failure_code: null,
    pause: {
      reason: "source_transport_retries_exhausted",
      request_id: "required-source",
      hostname: "network-pause-official-source.invalid",
      retry_generation: 1,
      attempt_count: 4,
      failure_classification: "network_failure",
      http_status: null,
      actions: ["resume"],
    },
  });
  expect(
    paused.diagnostics.map((diagnostic) => diagnostic.outcome),
  ).toEqual([
    "network_failure",
    "network_failure",
    "network_failure",
    "network_failure",
  ]);
});

test("an empty Retry-After header is ignored rather than read as zero", async () => {
  const run = await createCollection(
    "retry_pause_empty_retry_after_001",
    "https://empty-retry-after-official-source.invalid/retry-after-empty",
  );
  const response = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  const paused = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    20_000,
  );
  // An empty Retry-After carries no timing instruction: the audit records
  // no retry_after_ms and the retry waits on the exponential backoff.
  expect(
    paused.diagnostics.map((diagnostic) => diagnostic.retry_after_ms),
  ).toEqual([null, null, null, null]);
});
