import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pauseEvidenceRunForWorkflowRecovery,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/shared";
import { fusionWorldProductionCollectionRequests } from "./production-collection-request-goldens";
import {
  administrationRequest,
  type CollectionDocument,
  createCollection,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
  showCollection,
  waitForEvidenceCondition,
  waitForEvidenceRun,
  waitForParseOperation,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

const fusionWorldDiscoveryUrl = officialSourceDiscoveryRequests("fusion-world-en")[0]!.url;

test("a successful Official Source response is snapshotted before parsing", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "source_collection_success_001",
    requests: [
      {
        id: "cards",
        url: "https://official-source.invalid/cards",
      },
    ],
  });
  expect(created.status).toBe(201);
  const planned = await created.json<CollectionDocument>();
  expect(planned.state).toBe("collecting");
  const lifecycle = await administrationRequest(`/v1/ingestion-runs/${planned.id}`, "GET");
  expect(lifecycle.status).toBe(200);
  await expect(lifecycle.json()).resolves.toMatchObject({
    id: planned.id,
    state: "collecting",
    selected_games: ["one-piece"],
  });

  const resumed = await administrationRequest(`/v1/ingestion-runs/${planned.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    ingestion_run_id: string;
    workflow: { id: string; status: string };
  }>();
  expect(accepted).toMatchObject({
    ingestion_run_id: planned.id,
    workflow: {
      status: expect.stringMatching(/^(queued|running|waiting|complete)$/),
    },
  });
  const replayedResume = await administrationRequest(`/v1/ingestion-runs/${planned.id}/collection/resume`, "POST");
  expect(replayedResume.status).toBe(202);
  await expect(replayedResume.json()).resolves.toMatchObject({
    ingestion_run_id: planned.id,
    workflow: { id: accepted.workflow.id },
  });

  const completed = await waitForEvidenceRun(planned.id, "parsing");

  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(1);
  const snapshot = completed.snapshots[0];
  if (snapshot === undefined) throw new Error("missing Source Snapshot");
  expect(snapshot).toMatchObject({
    request: {
      method: "GET",
      url: "https://official-source.invalid/cards",
    },
    http: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: '"cards-v1"',
      },
    },
    adapter_version: "fixture-one-piece-json@3",
    ingestion_run_id: planned.id,
  });
  expect(snapshot.content).toMatchObject({
    byte_length: 60,
  });
  expect(snapshot.content.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.content.object_key).toMatch(/^source-snapshots\/srcsnap_[A-Za-z0-9-]+\.bin$/);

  expect(completed.observation_sets).toHaveLength(1);
  const observationSet = completed.observation_sets[0];
  if (observationSet === undefined) {
    throw new Error("missing Source Observation set");
  }
  expect(observationSet).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@3",
    observation_count: 1,
  });
  expect(observationSet.content_digest).toMatch(/^[a-f0-9]{64}$/);
  expect(observationSet.object_key).toMatch(/^source-observations\/srcobsset_[A-Za-z0-9-]+\.json$/);

  const snapshotContent = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/content`, "GET");
  expect(snapshotContent.status).toBe(200);
  expect(snapshotContent.headers.get("etag")).toBe(`"sha256-${snapshot.content.digest}"`);
  await expect(snapshotContent.text()).resolves.toBe('{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}');

  const observationContent = await administrationRequest(
    `/v1/source-observation-sets/${observationSet.id}/content`,
    "GET",
  );
  expect(observationContent.status).toBe(200);
  const observationDocument = await observationContent.json<{
    source_snapshot_id: string;
    adapter_version: string;
    observations: unknown[];
  }>();
  expect(observationDocument).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@3",
  });
  expect(observationDocument.observations).toHaveLength(1);

  const shown = await administrationRequest(`/v1/ingestion-runs/${planned.id}/evidence`, "GET");
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(completed);
});

test("the authenticated parent Workflow reconciles a complete production Evidence Plan after its collection barrier", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "source_parent_auto_reconcile_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    workflow: { id: string };
  }>();
  await waitForWorkflowStatus(
    accepted.workflow.id,
    async () => (await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id)).status(),
    "complete",
    20_000,
  );
  const completed = await showCollection(run.id);
  if (completed.state === "failed") {
    const failures = await env.CATALOGUE_DB.prepare(
      `SELECT request_id, failure_code FROM source_requests
       WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
       ORDER BY sequence_number`,
    )
      .bind(run.id)
      .all();
    throw new Error(
      JSON.stringify({
        failure_code: completed.failure_code,
        source_failures: failures.results,
      }),
    );
  }
  expect(completed).toMatchObject({
    id: run.id,
    state: "awaiting_approval",
    failure_code: null,
  });
  expect(completed.snapshots.length).toBeGreaterThan(0);
  expect(completed.observation_sets.length).toBeGreaterThan(0);
  expect(completed.official_source_collection_plans).toMatchObject([
    {
      source_lineage: "fusion-world-en",
      contract: "card-keepr-official-source-collection-plan@1",
      discovery_observation_set_id: expect.stringMatching(/^srcobsset_/u),
      content_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      plan: {
        source_lineage: "fusion-world-en",
        requests: fusionWorldProductionCollectionRequests.map((request) => ({
          ...request,
          surface: request.id.slice("fusion-world-en:".length),
        })),
      },
    },
  ]);
  const discoveryPlan = completed.official_source_collection_plans[0];
  const discoveryObservation = completed.observation_sets.find(
    ({ id }) => id === discoveryPlan?.discovery_observation_set_id,
  );
  expect(discoveryObservation).toBeDefined();
  const retainedObservation = await administrationRequest(
    `/v1/source-observation-sets/${discoveryObservation!.id}/content`,
    "GET",
  );
  expect(retainedObservation.status).toBe(200);
  await expect(retainedObservation.json()).resolves.toMatchObject({
    source_snapshot_id: discoveryObservation!.source_snapshot_id,
    adapter_version: "fusion-world-en@9",
    observations: [
      {
        value: {
          observation_type: "official_surface_evidence",
          source_lineage: "fusion-world-en",
          surface: "discovery",
          records: (
            [
              ["cards", "/fw/en/cardlist/?search=true&category%5B0%5D=583301"],
              ["products", "/fw/en/products/"],
              ["rules", "/fw/en/news/01_31.html"],
            ] as const
          ).map(([key, resolution]) => ({
            id: `fusion-world-en:discovery-seed:${key}`,
            surface: `@seed:${key}`,
            method: "GET",
            url: new URL(resolution, fusionWorldDiscoveryUrl).href,
            headers: { accept: "text/html" },
            discovered_from: {
              kind: "publisher_navigation",
              label: key === "products" ? "all products" : key,
              url: fusionWorldDiscoveryUrl,
              resolution,
            },
          })),
          completeness: {
            declared_record_count: 3,
            parsed_record_count: 3,
            required_surfaces_complete: true,
            partitions_complete: true,
            structurally_complete: true,
          },
        },
      },
    ],
  });
}, 30_000);

test("incomplete retained production discovery blocks collection and publication", async () => {
  const marker = "card-keepr-incomplete-discovery-v3";
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "source_parent_incomplete_discovery_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en").map((request) => ({
      ...request,
      headers: { ...request.headers, "user-agent": marker },
    })),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const terminal = await resumeCollection(run.id, 12_000);
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(terminal.snapshots).toHaveLength(1);
  expect(terminal.observation_sets).toEqual([]);
  expect(terminal.official_source_collection_plans).toEqual([]);
  expect(terminal.workflow.child_ids).toHaveLength(1);
  const candidate = await administrationRequest(`/v1/ingestion-runs/${run.id}/candidate`, "GET");
  expect(candidate.status).toBe(409);
}, 15_000);

test("notice-link-only production legality evidence fails closed before stale rules can carry forward", async () => {
  const marker = "card-keepr-notice-link-only-legality-v3";
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "source_parent_notice_only_legality_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en").map((request) => ({
      ...request,
      headers: { ...request.headers, "user-agent": marker },
    })),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const terminal = await resumeCollection(run.id, 12_000);
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  const candidate = await administrationRequest(`/v1/ingestion-runs/${run.id}/candidate`, "GET");
  expect(candidate.status).toBe(409);
}, 15_000);

test("the parent Workflow keeps a greater-than-1-MiB legality candidate in D1 and replays only a bounded reference", async () => {
  const marker = "card-keepr-large-legality-workflow-v3";
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: "source_parent_large_legality_001",
    requests: officialSourceDiscoveryRequests("fusion-world-en").map((request) => ({
      ...request,
      headers: { ...request.headers, "user-agent": marker },
    })),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id);
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 90_000);

  const assertBoundedOutput = async (expectsReference: boolean) => {
    const status = await parent.status();
    expect(status.status).toBe("complete");
    const output = status.output as Record<string, unknown>;
    expect(new TextEncoder().encode(JSON.stringify(output)).byteLength).toBeLessThan(524_288);
    expect(output).toMatchObject(
      expectsReference
        ? {
            ingestion_run_id: run.id,
            reconciliation: {
              contract: "card-keepr-reconciliation-workflow-result@1",
              run_id: run.id,
              candidate_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
          }
        : {
            ingestion_run_id: run.id,
            state: "awaiting_approval",
          },
    );
    expect(JSON.stringify(output)).not.toContain("legality_rules");
  };
  const candidateResponse = await administrationRequest(`/v1/ingestion-runs/${run.id}/candidate`, "GET");
  expect(candidateResponse.status).toBe(200);
  const candidate = await candidateResponse.json<Record<string, unknown>>();
  expect(candidate).toMatchObject({
    diff: {
      summary: {
        legality_rules_added: 4_000,
        legality_rules_current: 4_000,
      },
    },
  });
  const persisted = await env.CATALOGUE_DB.prepare(
    `SELECT SUM(length(CAST(content AS BLOB))) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ? AND payload_kind = 'candidate'`,
  )
    .bind(run.id)
    .first<{ candidate_bytes: number }>();
  expect(persisted?.candidate_bytes).toBeGreaterThan(1_048_576);

  await assertBoundedOutput(true);

  await parent.restart();
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 90_000);
  await assertBoundedOutput(false);
}, 120_000);

test("resuming collection reactivates an errored hostname Workflow with one persisted replacement", async () => {
  const run = await createCollection("source_collection_existing_child_001", "https://official-source.invalid/cards");
  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_initial_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_initial_parse_d1_outage');
     END`,
  ).run();
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const staged = await waitForParseOperation(run.id, "uploaded");
  const collecting = await showCollection(run.id);
  const childId = collecting.workflow.child_ids[0];
  if (childId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  await waitForWorkflowStatus(childId, async () => (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(), "errored");
  expect(staged.state).toBe("uploaded");
  await env.CATALOGUE_DB.prepare("DROP TRIGGER fail_initial_observation_set_insert").run();

  const completed = await resumeCollection(run.id);

  expect(completed.state).toBe("parsing");
  expect(completed.workflow.child_ids).toEqual([childId, `${childId}-attempt-0`]);
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.observation_sets).toHaveLength(1);
}, 15_000);

test("a full parent restart retains history and appends one bounded child identity", async () => {
  const created = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "source_stable_hostname_mapping_001",
    requests: [
      {
        id: "completed-host",
        url: "https://mapping-a-official-source.invalid/cards",
      },
      {
        id: "remaining-host",
        url: "https://mapping-z-official-source.invalid/retry-once",
      },
    ],
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const interrupted = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.snapshots.length === 1 &&
      current.diagnostics.some(
        (diagnostic) => diagnostic.request_id === "remaining-host" && diagnostic.outcome === "http_failure",
      ),
  );
  expect(interrupted.workflow.child_ids).toHaveLength(2);
  const originalChildIds = interrupted.workflow.child_ids;
  const remainingChildId = originalChildIds[1];
  if (remainingChildId === undefined) {
    throw new Error("missing remaining hostname Workflow identity");
  }
  const remainingChild = await env.EVIDENCE_HOST_WORKFLOW.get(remainingChildId);
  await remainingChild.terminate();
  const parentId = interrupted.workflow.parent_id;
  if (parentId === null) throw new Error("missing parent Workflow identity");
  await waitForWorkflowStatus(
    parentId,
    async () => (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "complete",
  );
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId);
  await parent.restart();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.workflow.child_ids.length === originalChildIds.length + 1 &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    25_000,
  );
  expect(completed.workflow.child_ids).toEqual([...originalChildIds, `${remainingChildId}-attempt-0`].sort());
  expect(completed.snapshots).toHaveLength(2);
  expect(completed.observation_sets).toHaveLength(2);
}, 30_000);

test("redirects and terminal HTTP failures remain diagnostics without Source Snapshots", async () => {
  const redirectRun = await createCollection(
    "source_collection_redirect_001",
    "https://official-source.invalid/redirect",
  );
  const rejectedResponse = await administrationRequest(
    `/v1/ingestion-runs/${redirectRun.id}/collection/resume`,
    "POST",
  );
  expect(rejectedResponse.status).toBe(202);
  await rejectedResponse.body?.cancel();
  const rejected = (await waitForEvidenceRun(redirectRun.id, "failed")) as CollectionDocument;
  expect(rejected).toMatchObject({
    state: "failed",
    failure_code: "source_redirect_rejected",
    snapshots: [],
  });
  expect(rejected.diagnostics).toHaveLength(1);
  expect(rejected.diagnostics[0]).toMatchObject({
    attempt_number: 1,
    outcome: "redirect",
    http_status: 302,
  });

  const exhaustedRun = await createCollection(
    "source_collection_failed_001",
    "https://failed-official-source.invalid/unavailable",
  );
  const exhaustedResponse = await administrationRequest(
    `/v1/ingestion-runs/${exhaustedRun.id}/collection/resume`,
    "POST",
  );
  expect(exhaustedResponse.status).toBe(202);
  await exhaustedResponse.body?.cancel();
  // Exhausting the retryable 503 responses pauses the run with the
  // transport reason instead of failing it; the attempts stay recorded as
  // diagnostics without Source Snapshots.
  const pausedByExhaustion = (await waitForEvidenceCondition(
    exhaustedRun.id,
    (current) => current.state === "paused",
    12_000,
  )) as CollectionDocument;
  expect(pausedByExhaustion).toMatchObject({
    state: "paused",
    failure_code: null,
    pause: {
      reason: "source_transport_retries_exhausted",
      failure_classification: "http_failure",
      http_status: 503,
    },
    snapshots: [],
  });
  expect(pausedByExhaustion.diagnostics).toHaveLength(4);
  expect(
    pausedByExhaustion.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
      status: diagnostic.http_status,
      retry_after_ms: diagnostic.retry_after_ms,
    })),
  ).toEqual([
    {
      attempt_number: 1,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 2,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 3,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 4,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
  ]);

  // A paused run is not terminal: the generic linked-evidence retry stays
  // rejected, because the same run remains resumable.
  const retriedResponse = await administrationRequest(
    `/v1/ingestion-runs/${pausedByExhaustion.id}/collection/retry`,
    "POST",
    { idempotency_key: "source_collection_failed_retry_001" },
  );
  expect(retriedResponse.status).toBe(409);
  await expect(retriedResponse.json()).resolves.toMatchObject({
    code: "ingestion_run_not_retryable",
  });
});

test("the parent Workflow creates a persisted dynamic host child before recovery inspects it", async () => {
  const run = await createCollection(
    "source_dynamic_host_creation_gap_001",
    "https://official-source.invalid/retry-once",
  );
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const collecting = await waitForEvidenceCondition(run.id, (current) => current.workflow.child_ids.length === 1);
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const parentRequest = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (parentRequest === undefined) {
    throw new Error("pending parent request missing");
  }
  await appendDiscoveredEvidenceRequests(env.CATALOGUE_DB, storedRun, parentRequest, [
    {
      role: "detail",
      url: "https://dynamic-b-official-source.invalid/cards",
      headers: {},
    },
  ]);
  const originalChildId = collecting.workflow.child_ids[0];
  if (originalChildId === undefined) {
    throw new Error("original host Workflow identity missing");
  }
  await (await env.EVIDENCE_HOST_WORKFLOW.get(originalChildId)).terminate();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.state === "parsing" && current.snapshots.length === 2 && current.observation_sets.length === 2,
    15_000,
  );
  expect(completed.snapshots.map(({ request }) => new URL(request.url).hostname).sort()).toEqual([
    "dynamic-b-official-source.invalid",
    "official-source.invalid",
  ]);
});

test("the parent Workflow fails deterministically at the persisted child-attempt ceiling", async () => {
  const run = await createCollection("source_child_attempt_bound_001", "https://official-source.invalid/cards");
  const baseChildId = `evidence-host-${await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: run.id,
        hostname: "official-source.invalid",
        minimum_sequence_number: 0,
        maximum_sequence_number: 199,
      }),
    ),
  )}`;
  const exhaustedIds = [
    baseChildId,
    `${baseChildId}-attempt-0`,
    `${baseChildId}-attempt-1`,
    `${baseChildId}-attempt-2`,
  ];
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET child_workflow_ids_json = ?
     WHERE ingestion_run_id = ?`,
  )
    .bind(canonicalJson(exhaustedIds), run.id)
    .run();

  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const terminal = await waitForEvidenceCondition(run.id, (current) => current.state !== "collecting", 15_000);
  expect(terminal).toMatchObject({
    state: "failed",
    failure_code: "source_workflow_retries_exhausted",
    workflow: { child_ids: exhaustedIds },
  });
  expect(terminal.workflow.child_ids).toHaveLength(4);
});

test("a hostname Workflow that wakes to a terminated run finishes without reloading its pending request", async () => {
  // Issue #163: the hostname shard's stage loop only stopped for a paused
  // run. A run that left its collection phase any other way (termination,
  // a failure recorded by another shard) with a request still pending kept
  // the shard reloading that request through four durable steps per stage
  // with no sleep, hammering D1 and the Workflow engine until its runtime
  // was torn down. The retained request is audit evidence, not work.
  const run = await createCollection("source_child_terminated_run_001", "https://official-source.invalid/cards");
  const parentId = `evidence-${run.id}`;
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_evidence_plans SET parent_workflow_id = ?
     WHERE ingestion_run_id = ?`,
  )
    .bind(parentId, run.id)
    .run();
  await pauseEvidenceRunForWorkflowRecovery(env.CATALOGUE_DB, run.id, {
    workflow_instance_id: parentId,
    pause_reason: "source_workflow_unavailable",
    workflow_status: "unavailable",
    last_progress_at: null,
  });
  const terminated = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/termination`, "POST", {
    idempotency_key: "source_child_terminated_run_terminate_001",
  });
  expect(terminated.status).toBe(200);
  await expect(terminated.json()).resolves.toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });

  // The shard identity the parent would have minted for the pending
  // request; termination could not terminate it because it was never
  // recorded, exactly as when a parent dies before its record step.
  const childId = `evidence-host-${await sha256(
    utf8(
      canonicalJson({
        ingestion_run_id: run.id,
        hostname: "official-source.invalid",
        minimum_sequence_number: 0,
        maximum_sequence_number: 199,
      }),
    ),
  )}`;
  await env.EVIDENCE_HOST_WORKFLOW.create({
    id: childId,
    params: {
      ingestion_run_id: run.id,
      hostname: "official-source.invalid",
      minimum_sequence_number: 0,
      maximum_sequence_number: 199,
    },
  });
  await waitForWorkflowStatus(
    childId,
    async () => (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(),
    "complete",
    10_000,
  );
  const requests = await env.CATALOGUE_DB.prepare(`SELECT state FROM source_requests WHERE ingestion_run_id = ?`)
    .bind(run.id)
    .all<{ state: string }>();
  expect(requests.results).toEqual([{ state: "pending" }]);
  const captures = await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_fetch_attempts
     WHERE ingestion_run_id = ?`,
  )
    .bind(run.id)
    .first<{ count: number }>();
  expect(captures?.count).toBe(0);
});

test("a completed host shard durably releases the next same-host shard", async () => {
  const run = await createCollection(
    "source_workflow_shard_progression_001",
    "https://official-source.invalid/sequence/root",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 200 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/sequence/shard-${String(index + 1).padStart(3, "0")}`,
      headers: { accept: "application/json" },
    })),
  );
  // Bounded test setup leaves one live request in each 200-sequence shard.
  await env.CATALOGUE_DB.prepare(
    `UPDATE source_requests SET state = 'observed'
     WHERE ingestion_run_id = ? AND sequence_number BETWEEN 1 AND 199`,
  )
    .bind(run.id)
    .run();

  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" && current.snapshots.length === 2 && current.workflow.child_ids.length === 3,
    15_000,
  );
  expect(completed.snapshots.map(({ request }) => request.url).sort()).toEqual([
    "https://official-source.invalid/sequence/root",
    "https://official-source.invalid/sequence/shard-200",
  ]);
  expect(completed.workflow.child_ids.filter((id) => id.endsWith("-attempt-0"))).toHaveLength(1);
}, 30_000);

test("dynamic discovery preserves the first edge when two parents reach one immutable request", async () => {
  const run = await createCollection("source_dynamic_shared_request_001", "https://official-source.invalid/cards");
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  const discovered = [
    {
      role: "detail" as const,
      url: "https://official-source.invalid/cards/one",
      headers: { accept: "text/html" },
    },
    {
      role: "detail" as const,
      url: "https://official-source.invalid/cards/two",
      headers: { accept: "text/html" },
    },
  ];
  const [first, second] = await appendDiscoveredEvidenceRequests(env.CATALOGUE_DB, storedRun, root, discovered);
  if (first === undefined || second === undefined) {
    throw new Error("dynamic requests were not persisted");
  }

  const replayed = await appendDiscoveredEvidenceRequests(env.CATALOGUE_DB, storedRun, first, [discovered[1]!]);

  expect(replayed).toHaveLength(1);
  expect(replayed[0]).toMatchObject({
    request_id: second.request_id,
    discovered_from_request_id: root.request_id,
  });
  expect(
    await env.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
    )
      .bind(run.id)
      .first("count"),
  ).toBe(3);
});
