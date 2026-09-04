import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
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
import {
  fusionWorldRequestCapacity,
  pauseRunAtCapacity,
} from "./capacity-pause-helpers";

installRuntimeSuite();

type CollectionInspection = {
  state: string;
  pause_reason: string | null;
  paused_at: string | null;
  last_progress_at: string | null;
  expected_catalogue_revision_id: string;
  collection_completed_at: string | null;
  capacity: Array<Record<string, unknown>>;
  requests: {
    total: number;
    by_state: Record<string, number>;
    by_role: Record<string, number>;
    by_lineage: Array<{
      source_lineage: string;
      total: number;
      by_state: Record<string, number>;
      by_role: Record<string, number>;
    }>;
  };
  evidence: Record<string, unknown>;
  progress: { current_request: Record<string, unknown> | null };
  pacing: {
    mode: string;
    interval_ms: number;
    hosts: Array<Record<string, unknown>>;
  };
  estimate: Record<string, unknown>;
};

test("a capacity-paused production-shaped run reports aggregated capacity, request, evidence, and pacing facts", async () => {
  const { runId, root, snapshotId } = await pauseRunAtCapacity(
    "collection_inspection_capacity_001",
    "observed",
  );
  const pause = await env.CATALOGUE_DB.prepare(
    `SELECT paused_at, overflow_request_count, required_capacity
     FROM ingestion_run_capacity_pauses WHERE ingestion_run_id = ?`,
  ).bind(runId).first<{
    paused_at: string;
    overflow_request_count: number;
    required_capacity: number;
  }>();
  if (pause === null) throw new Error("capacity pause record is absent");
  const snapshotBytes = await env.CATALOGUE_DB.prepare(
    "SELECT content_byte_length FROM source_snapshots WHERE id = ?",
  ).bind(snapshotId).first("content_byte_length");

  const document = await showCollection(runId) as unknown as Record<string, unknown> & {
    collection: CollectionInspection;
  };
  const collection = document.collection;
  expect(collection).toMatchObject({
    state: "paused",
    pause_reason: "source_request_capacity_exhausted",
    paused_at: pause.paused_at,
    expected_catalogue_revision_id: document.expected_current_revision_id,
    collection_completed_at: null,
  });
  expect(collection.last_progress_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

  // Capacity is reported per Source Lineage with the generation, the used
  // and remaining identities, and the capacity the rejected batch requires.
  expect(collection.capacity).toEqual([{
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    capacity_generation: 1,
    request_capacity: fusionWorldRequestCapacity,
    used_capacity: fusionWorldRequestCapacity,
    remaining_capacity: 0,
    required_capacity: pause.required_capacity,
    overflow_request_count: pause.overflow_request_count,
  }]);

  // Request counts group by lineage, role, and lifecycle state.
  expect(collection.requests).toEqual({
    total: fusionWorldRequestCapacity,
    by_state: { captured: 1, observed: fusionWorldRequestCapacity - 1 },
    by_role: { surface: 1, detail: fusionWorldRequestCapacity - 1 },
    by_lineage: [{
      source_lineage: "fusion-world-en",
      total: fusionWorldRequestCapacity,
      by_state: { captured: 1, observed: fusionWorldRequestCapacity - 1 },
      by_role: { surface: 1, detail: fusionWorldRequestCapacity - 1 },
    }],
  });

  // Evidence volume is counted, never materialized: snapshot count and
  // retained bytes, observation sets, and attempt/retry counts.
  expect(collection.evidence).toEqual({
    snapshot_count: 1,
    retained_byte_total: snapshotBytes,
    observation_set_count: 1,
    fetch_attempt_count: 1,
    retry_attempt_count: 0,
    failed_attempt_count: 0,
    latest_failure: null,
    detail_limit: 200,
    snapshots_truncated: false,
    observation_sets_truncated: false,
    diagnostics_truncated: false,
  });

  // The current safe request reference: identity, hostname, role, state,
  // and attempt count only.
  expect(collection.progress.current_request).toEqual({
    request_id: root.request_id,
    hostname: "www.dbs-cardgame.com",
    role: "surface",
    state: "captured",
    attempt_count: 1,
    last_attempt_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
  });

  // Host pacing lists the hosts with open work; the remaining-time figure
  // is explicitly advisory.
  expect(collection.pacing).toMatchObject({
    mode: "immediate",
    interval_ms: 500,
    hosts: [{
      hostname: "www.dbs-cardgame.com",
      pending_request_count: 0,
      captured_request_count: 1,
      waiting_ms: 0,
    }],
  });
  expect(collection.estimate).toEqual({
    advisory: true,
    pending_request_count: 0,
    captured_request_count: 1,
    active_host_count: 1,
    minimum_remaining_ms: 0,
  });

  // Nothing in the inspection block carries request headers, credentials,
  // or retained bytes.
  const serialized = JSON.stringify(collection);
  expect(serialized).not.toContain("accept");
  expect(serialized).not.toContain("authorization");
  expect(serialized).not.toContain("body_base64");
  expect(document.actions).toEqual(["resume", "extend_capacity", "terminate"]);
}, 60_000);

test("a transport-paused run reports retry counts, the latest safe failure, and Workflow attempt statuses", async () => {
  const run = await createCollection(
    "collection_inspection_retry_001",
    "https://inspection-official-source.invalid/unavailable",
  );
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    12_000,
  ) as unknown as Record<string, unknown> & { collection: CollectionInspection };
  const collection = paused.collection;
  expect(collection).toMatchObject({
    state: "paused",
    pause_reason: "source_transport_retries_exhausted",
  });
  expect(collection.requests).toEqual({
    total: 1,
    by_state: { pending: 1 },
    by_role: { surface: 1 },
    by_lineage: [{
      source_lineage: "one-piece-en",
      total: 1,
      by_state: { pending: 1 },
      by_role: { surface: 1 },
    }],
  });
  expect(collection.capacity).toEqual([{
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    capacity_generation: 1,
    request_capacity: 5_000,
    used_capacity: 1,
    remaining_capacity: 4_999,
    required_capacity: null,
    overflow_request_count: null,
  }]);
  expect(collection.evidence).toMatchObject({
    snapshot_count: 0,
    retained_byte_total: 0,
    observation_set_count: 0,
    fetch_attempt_count: 4,
    retry_attempt_count: 3,
    failed_attempt_count: 4,
    latest_failure: {
      request_id: "required-source",
      hostname: "inspection-official-source.invalid",
      classification: "http_failure",
      http_status: 503,
      attempt_number: 4,
    },
  });
  expect(collection.progress.current_request).toMatchObject({
    request_id: "required-source",
    hostname: "inspection-official-source.invalid",
    role: "surface",
    state: "pending",
    attempt_count: 4,
  });
  expect(collection.pacing.hosts).toEqual([{
    hostname: "inspection-official-source.invalid",
    pending_request_count: 1,
    captured_request_count: 0,
    next_request_not_before: expect.any(String),
    waiting_ms: expect.any(Number),
  }]);
  expect(collection.estimate).toMatchObject({
    advisory: true,
    pending_request_count: 1,
    active_host_count: 1,
  });

  // Every recorded parent and child Workflow Attempt carries a safe status
  // and exactly one attempt per scope is current.
  const workflow = paused.workflow as {
    attempts: Array<{ kind: string; status: string; current: boolean }>;
    current_attempt: { status: string } | null;
  };
  expect(workflow.attempts.length).toBeGreaterThanOrEqual(2);
  for (const attempt of workflow.attempts) {
    expect([
      "queued", "running", "paused", "errored", "terminated", "complete",
      "waiting", "waiting_for_pause", "unknown", "unavailable",
    ]).toContain(attempt.status);
  }
  expect(workflow.attempts.filter((attempt) => attempt.kind === "parent"))
    .toHaveLength(1);
  expect(workflow.attempts.filter((attempt) => attempt.current))
    .toHaveLength(2);
  expect(workflow.current_attempt?.status).toBe(
    workflow.attempts.find((attempt) => attempt.kind === "parent")?.status,
  );
  expect(paused.actions).toEqual(["resume", "terminate"]);
});

test("per-request detail is bounded while aggregate counts stay exact", async () => {
  const { runId } = await pauseRunAtCapacity(
    "collection_inspection_bounded_001",
    "observed",
  );
  // Retain 250 synthetic failed attempts across filler requests so the
  // attempt history exceeds the detail bound.
  await env.CATALOGUE_DB.prepare(
    `WITH RECURSIVE filler(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < 250
     )
     INSERT INTO source_fetch_attempts (
       id, ingestion_run_id, request_id, attempt_number, requested_at,
       completed_at, outcome, http_status, response_headers_json,
       retry_after_ms, diagnostic
     )
     SELECT 'srcfetch_bounded_' || printf('%08d', n), ?1,
            'fusion-world-en:detail:' || printf('%08d', n), 1,
            '2026-08-07T01:00:00.000Z',
            '2026-08-07T01:' || printf('%02d', n / 60) || ':' ||
              printf('%02d', n % 60) || '.000Z',
            'http_failure', 503, '{}', NULL, NULL
     FROM filler`,
  ).bind(runId).run();
  const document = await showCollection(runId) as unknown as Record<string, unknown> & {
    collection: CollectionInspection;
    diagnostics: Array<{ request_id: string; attempt_number: number }>;
  };
  expect(document.collection.evidence).toMatchObject({
    fetch_attempt_count: 251,
    failed_attempt_count: 250,
    retry_attempt_count: 0,
    detail_limit: 200,
    diagnostics_truncated: true,
    snapshots_truncated: false,
    latest_failure: {
      request_id: "fusion-world-en:detail:00000250",
      attempt_number: 1,
      classification: "http_failure",
      http_status: 503,
    },
  });
  expect(document.diagnostics).toHaveLength(200);
  // The retained detail is the newest attempts, listed in stable order.
  const listed = document.diagnostics.map((attempt) => attempt.request_id);
  expect(listed).toEqual([...listed].sort());
  expect(listed).not.toContain("fusion-world-en:detail:00000001");
  expect(listed).toContain("fusion-world-en:detail:00000250");
  const diagnostics = document.operational_diagnostics as {
    terminal_evidence: { coverage: Record<string, number> };
  };
  expect(diagnostics.terminal_evidence.coverage).toEqual({
    evidence_plan_count: 1,
    source_snapshot_count: 1,
    source_observation_set_count: 1,
    fetch_attempt_count: 251,
  });
}, 60_000);

test("request counts group listing, detail, product-detail, image, and surface roles per lineage", async () => {
  const run = await createCollection(
    "collection_inspection_roles_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  const discovered = [
    { role: "listing" as const, url: "https://official-source.invalid/listing/1" },
    { role: "listing" as const, url: "https://official-source.invalid/listing/2" },
    { role: "detail" as const, url: "https://official-source.invalid/cards/1" },
    { role: "detail" as const, url: "https://official-source.invalid/cards/2" },
    { role: "detail" as const, url: "https://official-source.invalid/cards/3" },
    { role: "product_detail" as const, url: "https://official-source.invalid/products/1" },
    { role: "image" as const, url: "https://official-source.invalid/images/1.png" },
    { role: "image" as const, url: "https://official-source.invalid/images/2.png" },
    { role: "image" as const, url: "https://official-source.invalid/images/3.png" },
    { role: "image" as const, url: "https://official-source.invalid/images/4.png" },
  ].map((request) => ({ ...request, headers: { accept: "*/*" } }));
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    discovered,
  );
  const document = await showCollection(run.id) as unknown as {
    collection: CollectionInspection;
  };
  expect(document.collection.requests).toEqual({
    total: 11,
    by_state: { pending: 11 },
    by_role: { surface: 1, listing: 2, detail: 3, product_detail: 1, image: 4 },
    by_lineage: [{
      source_lineage: "one-piece-en",
      total: 11,
      by_state: { pending: 11 },
      by_role: {
        surface: 1,
        listing: 2,
        detail: 3,
        product_detail: 1,
        image: 4,
      },
    }],
  });
  expect(document.collection.capacity).toMatchObject([{
    source_lineage: "one-piece-en",
    used_capacity: 11,
    remaining_capacity: 4_989,
  }]);
});

// workerd's D1 caps LIKE patterns at 50 characters, so a progress query that
// builds its pattern from the hostname threw for any Official Source
// hostname over 45 characters and inspection returned 500 (#168). The
// hostname here is 64 characters and stays live in the host pacing table
// with an open request, which is exactly the row the progress query scans.
test("collection inspection succeeds for a 64-character Official Source hostname", async () => {
  const hostname = `${
    "inspection-long-hostname".padEnd(40, "x")
  }-official-source.invalid`;
  expect(hostname).toHaveLength(64);
  const run = await createCollection(
    "collection_inspection_long_hostname_001",
    `https://${hostname}/unavailable`,
  );
  const started = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "paused",
    12_000,
  ) as unknown as Record<string, unknown> & { collection: CollectionInspection };
  const collection = paused.collection;
  expect(collection).toMatchObject({
    state: "paused",
    pause_reason: "source_transport_retries_exhausted",
  });
  expect(collection.last_progress_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  expect(collection.progress.current_request).toMatchObject({
    request_id: "required-source",
    hostname,
    state: "pending",
  });
  expect(collection.pacing.hosts).toEqual([{
    hostname,
    pending_request_count: 1,
    captured_request_count: 0,
    next_request_not_before: expect.any(String),
    waiting_ms: expect.any(Number),
  }]);
});
