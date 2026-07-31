import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  captureOperationIdentity,
  capturePreparedAttempt,
  prepareCaptureAttempt,
} from "../../../src/catalogue/source-evidence-capture";
import { sourceAdapterRegistrations } from "../../../src/catalogue/source-adapters";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/product-release-source-adapters";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
  // Workflow instances outlive a Vitest request isolate. Reset only the
  // singleton lock so each test begins with an independent administration
  // scenario; production never performs this test-only setup.
  await env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
});

test("the administration authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });
});

test("every pinned aggregate adapter retains its immutable parser contract", () => {
  const pinned = [
    "one-piece-json-document@1",
    "one-piece-json-document@2",
    "fusion-world-en@1",
    "digimon-en@1",
    "gundam-en-asia@1",
    "gundam-en-us@1",
  ];
  for (const adapterVersion of pinned) {
    const adapter = sourceAdapterRegistrations.find(
      (candidate) => candidate.adapterVersion === adapterVersion,
    );
    expect(adapter, adapterVersion).toBeDefined();
    expect(adapter?.maximumSnapshotBytes, adapterVersion).toBe(1024 * 1024);
    expect(adapter?.parse, adapterVersion).toBeTypeOf("function");
    expect(
      adapter?.parse?.({
        cards: [{ card: adapterVersion }],
        product_surfaces: [{
          product: "must-not-be-added-by-the-pinned-parser",
        }],
      }),
      adapterVersion,
    ).toEqual([{ card: adapterVersion }]);
  }
});

test.each([
  {
    adapter: "one-piece-json-document@1",
    fixture: "fixture-one-piece-json@1",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "one-piece-json-document@2",
    fixture: "fixture-one-piece-json@1",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "fusion-world-en@1",
    fixture: "fixture-fusion-world-json@1",
    game: "fusion-world",
    lineage: "fusion-world-en",
  },
  {
    adapter: "digimon-en@1",
    fixture: "fixture-digimon-json@1",
    game: "digimon",
    lineage: "digimon-en",
  },
  {
    adapter: "gundam-en-asia@1",
    fixture: "fixture-gundam-en-asia-json@1",
    game: "gundam",
    lineage: "gundam-en-asia",
  },
  {
    adapter: "gundam-en-us@1",
    fixture: "fixture-gundam-en-us-json@1",
    game: "gundam",
    lineage: "gundam-en-us",
  },
])(
  "the authenticated API reparses retained snapshots with $adapter",
  async ({ adapter, fixture, game, lineage }) => {
    const created = await fixtureEvidenceRequest({
      supported_game: game,
      source_lineage: lineage,
      adapter_version: fixture,
      idempotency_key: `pinned-reparse-source-${adapter}`,
      requests: [{
        id: `source-${adapter}`,
        url: "https://official-source.invalid/cards",
      }],
    });
    expect(created.status).toBe(201);
    const run = await created.json<CollectionDocument>();
    const completed = await resumeCollection(run.id);
    const snapshot = completed.snapshots[0];
    if (snapshot === undefined) throw new Error("retained snapshot missing");

    const response = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: adapter,
        idempotency_key: `pinned-reparse-intent-${adapter}`,
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      source_snapshot_id: snapshot.id,
      adapter_version: adapter,
      observation_count: 1,
    });
  },
);

test("a successful Official Source response is snapshotted before parsing", async () => {
  const created = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "source_collection_success_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  const planned = await created.json<{
    id: string;
    state: string;
  }>();
  expect(planned.state).toBe("collecting");
  const lifecycle = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}`,
    "GET",
  );
  expect(lifecycle.status).toBe(200);
  await expect(lifecycle.json()).resolves.toMatchObject({
    id: planned.id,
    state: "collecting",
    selected_games: ["one-piece"],
  });

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
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
  const replayedResume = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/collection/resume`,
    "POST",
  );
  expect(replayedResume.status).toBe(202);
  await expect(replayedResume.json()).resolves.toMatchObject({
    ingestion_run_id: planned.id,
    workflow: { id: accepted.workflow.id },
  });

  const completed = await waitForEvidenceRun(
    planned.id,
    "parsing",
  );

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
    adapter_version: "fixture-one-piece-json@1",
    ingestion_run_id: planned.id,
  });
  expect(snapshot.content).toMatchObject({
    byte_length: 60,
  });
  expect(snapshot.content.digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(snapshot.content.object_key).toMatch(
    /^source-snapshots\/srcsnap_[A-Za-z0-9-]+\.bin$/,
  );

  expect(completed.observation_sets).toHaveLength(1);
  const observationSet = completed.observation_sets[0];
  if (observationSet === undefined) {
    throw new Error("missing Source Observation set");
  }
  expect(observationSet).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@1",
    observation_count: 1,
  });
  expect(observationSet.content_digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(observationSet.object_key).toMatch(
    /^source-observations\/srcobsset_[A-Za-z0-9-]+\.json$/,
  );

  const snapshotContent = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/content`,
    "GET",
  );
  expect(snapshotContent.status).toBe(200);
  expect(snapshotContent.headers.get("etag")).toBe(
    `"sha256-${snapshot.content.digest}"`,
  );
  await expect(snapshotContent.text()).resolves.toBe(
    '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
  );

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
    adapter_version: "fixture-one-piece-json@1",
  });
  expect(observationDocument.observations).toHaveLength(1);

  const shown = await administrationRequest(
    `/v1/ingestion-runs/${planned.id}/evidence`,
    "GET",
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(completed);
});

test("the authenticated parent Workflow reconciles a complete production Evidence Plan after its collection barrier", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@2",
      idempotency_key: "source_parent_auto_reconcile_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{
    workflow: { id: string };
  }>();
  await waitForWorkflowStatus(
    accepted.workflow.id,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id))
        .status(),
    "complete",
  );
  const completed = await showCollection(run.id);
  expect(completed).toMatchObject({
    id: run.id,
    state: "awaiting_approval",
    failure_code: null,
  });
  expect(completed.snapshots.length).toBeGreaterThan(0);
  expect(completed.observation_sets.length).toBeGreaterThan(0);
}, 15_000);

test("resuming collection restarts an existing errored hostname Workflow and its staged parse", async () => {
  const run = await createCollection(
    "source_collection_existing_child_001",
    "https://official-source.invalid/cards",
  );
  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_initial_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_initial_parse_d1_outage');
     END`,
  ).run();
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const staged = await waitForParseOperation(run.id, "uploaded");
  const collecting = await showCollection(run.id);
  const childId = collecting.workflow.child_ids[0];
  if (childId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  await waitForWorkflowStatus(
    childId,
    async () =>
      (await env.EVIDENCE_HOST_WORKFLOW.get(childId)).status(),
    "errored",
  );
  expect(staged.state).toBe("uploaded");
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER fail_initial_observation_set_insert",
  ).run();

  const completed = await resumeCollection(run.id);

  expect(completed.state).toBe("parsing");
  expect(completed.snapshots).toHaveLength(1);
  expect(completed.observation_sets).toHaveLength(1);
}, 15_000);

test("a full parent restart preserves each pending hostname child identity", async () => {
  const created = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
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
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const interrupted = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.snapshots.length === 1 &&
      current.diagnostics.some(
        (diagnostic) =>
          diagnostic.request_id === "remaining-host" &&
          diagnostic.outcome === "http_failure",
      ),
  );
  expect(interrupted.workflow.child_ids).toHaveLength(2);
  const originalChildIds = interrupted.workflow.child_ids;
  const remainingChildId = originalChildIds[1];
  if (remainingChildId === undefined) {
    throw new Error("missing remaining hostname Workflow identity");
  }
  const remainingChild =
    await env.EVIDENCE_HOST_WORKFLOW.get(remainingChildId);
  await remainingChild.terminate();
  const parentId = interrupted.workflow.parent_id;
  if (parentId === null) throw new Error("missing parent Workflow identity");
  await waitForWorkflowStatus(
    parentId,
    async () =>
      (await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId)).status(),
    "complete",
  );
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(parentId);
  await parent.restart();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.workflow.child_ids.length === originalChildIds.length &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    25_000,
  );
  expect(completed.workflow.child_ids).toEqual(originalChildIds);
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
  const rejected = await waitForEvidenceRun(
    redirectRun.id,
    "failed",
  ) as CollectionDocument;
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

  const failedRun = await createCollection(
    "source_collection_failed_001",
    "https://failed-official-source.invalid/unavailable",
  );
  const failedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failedRun.id}/collection/resume`,
    "POST",
  );
  expect(failedResponse.status).toBe(202);
  await failedResponse.body?.cancel();
  const failed = await waitForEvidenceRun(
    failedRun.id,
    "failed",
    12_000,
  ) as CollectionDocument;
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
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

  const retriedResponse = await administrationRequest(
    `/v1/ingestion-runs/${failed.id}/collection/retry`,
    "POST",
    { idempotency_key: "source_collection_failed_retry_001" },
  );
  expect(retriedResponse.status).toBe(201);
  const retried = await retriedResponse.json<CollectionDocument>();
  expect(retried).toMatchObject({
    state: "collecting",
    linked_run_id: failed.id,
    snapshots: [],
    diagnostics: [],
  });
  expect(retried.id).not.toBe(failed.id);
});

test("the parent Workflow creates a persisted dynamic host child before recovery inspects it", async () => {
  const run = await createCollection(
    "source_dynamic_host_creation_gap_001",
    "https://official-source.invalid/retry-once",
  );
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const collecting = await waitForEvidenceCondition(
    run.id,
    (current) => current.workflow.child_ids.length === 1,
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const parentRequest = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (parentRequest === undefined) {
    throw new Error("pending parent request missing");
  }
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    [{
      role: "detail",
      url: "https://dynamic-b-official-source.invalid/cards",
      headers: {},
    }],
  );
  const originalChildId = collecting.workflow.child_ids[0];
  if (originalChildId === undefined) {
    throw new Error("original host Workflow identity missing");
  }
  await (await env.EVIDENCE_HOST_WORKFLOW.get(originalChildId)).terminate();

  const completed = await waitForEvidenceCondition(
    run.id,
    (current) =>
      current.state === "parsing" &&
      current.snapshots.length === 2 &&
      current.observation_sets.length === 2,
    15_000,
  );
  expect(
    completed.snapshots.map(({ request }) => new URL(request.url).hostname)
      .sort(),
  ).toEqual([
    "dynamic-b-official-source.invalid",
    "official-source.invalid",
  ]);
});

test(
  "successful captures remain auditable when a later required response is rejected or terminally fails",
  async () => {
    for (const scenario of [
      {
        key: "retained_after_rejected_001",
        terminalUrl:
          "https://retained-redirect-official-source.invalid/redirect",
        failureCode: "source_redirect_rejected",
      },
      {
        key: "retained_after_terminal_failure_001",
        terminalUrl:
          "https://retained-failure-official-source.invalid/unavailable",
        failureCode: "source_request_retries_exhausted",
      },
    ]) {
      const response = await fixtureEvidenceRequest(
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "fixture-one-piece-json@1",
          idempotency_key: scenario.key,
          requests: [
            {
              id: "captured",
              url: `https://${new URL(scenario.terminalUrl).hostname}/cards`,
            },
            { id: "terminal", url: scenario.terminalUrl },
          ],
        },
      );
      const run = await response.json<{ id: string }>();
      const terminal = await resumeCollection(run.id);
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: scenario.failureCode,
      });
      expect(terminal.snapshots).toHaveLength(1);
      expect(terminal.observation_sets).toHaveLength(1);

      const retained = await showCollection(run.id);
      expect(retained.snapshots).toEqual(terminal.snapshots);
      expect(retained.observation_sets).toEqual(
        terminal.observation_sets,
      );
    }
  },
  12_000,
);

test("a successful response remains snapshotted when parsing terminally fails", async () => {
  const run = await createCollection(
    "source_collection_parse_failure_001",
    "https://parse-failure-official-source.invalid/invalid-json",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(failed.snapshots).toHaveLength(1);
  expect(failed.observation_sets).toEqual([]);
  expect(failed.diagnostics).toHaveLength(1);
  expect(failed.diagnostics[0]).toMatchObject({
    outcome: "success",
    http_status: 200,
  });

  const retained = await showCollection(run.id);
  expect(retained.snapshots).toEqual(failed.snapshots);
});

test("validator revalidation creates fresh fetch evidence and reuses bytes only for the same adapter version", async () => {
  const firstRun = await createCollection(
    "source_collection_cache_first_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "en" },
  );
  const first = await resumeCollection(firstRun.id);
  const firstSnapshot = first.snapshots[0];
  if (firstSnapshot === undefined) throw new Error("missing first snapshot");
  await releaseActiveRunForNextScenario();

  const differentRepresentationRun = await createCollection(
    "source_collection_cache_language_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "fr" },
  );
  const differentRepresentation = await resumeCollection(
    differentRepresentationRun.id,
  );
  expect(differentRepresentation.snapshots[0]).toMatchObject({
    http: { status: 200 },
    reused_source_snapshot_id: null,
  });
  await releaseActiveRunForNextScenario();

  const revalidatedRun = await createCollection(
    "source_collection_cache_second_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@1",
    { "accept-language": "en" },
  );
  const revalidated = await resumeCollection(revalidatedRun.id);
  const revalidatedSnapshot = revalidated.snapshots[0];
  if (revalidatedSnapshot === undefined) {
    throw new Error("missing revalidated snapshot");
  }
  await releaseActiveRunForNextScenario();
  expect(revalidatedSnapshot).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: firstSnapshot.id,
    content: {
      digest: firstSnapshot.content.digest,
      object_key: firstSnapshot.content.object_key,
    },
  });
  expect(revalidated.diagnostics[0]).toMatchObject({
    outcome: "cache_revalidated",
    http_status: 304,
  });

  const changedAdapterRun = await createCollection(
    "source_collection_cache_adapter_changed_001",
    "https://official-source.invalid/conditional",
    "fixture-one-piece-json@2",
    { "accept-language": "en" },
  );
  const changedAdapter = await resumeCollection(changedAdapterRun.id);
  const changedAdapterSnapshot = changedAdapter.snapshots[0];
  if (changedAdapterSnapshot === undefined) {
    throw new Error("missing changed-adapter snapshot");
  }
  expect(changedAdapterSnapshot.http.status).toBe(200);
  expect(changedAdapterSnapshot.reused_source_snapshot_id).toBeNull();
}, 12_000);

test("Retry-After is audited without shortening the Official Source deadline", async () => {
  const run = await createCollection(
    "source_retry_after_long_001",
    "https://retry-after-official-source.invalid/retry-after-long",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const waiting = await waitForEvidenceDiagnostic(run.id);
  expect(waiting).toMatchObject({
    state: "collecting",
    diagnostics: [
      {
        attempt_number: 1,
        outcome: "http_failure",
        http_status: 503,
        retry_after_ms: 120_000,
      },
    ],
  });
  const childWorkflowId = waiting.workflow.child_ids[0];
  if (childWorkflowId === undefined) {
    throw new Error("missing hostname Workflow identity");
  }
  const childWorkflow = await env.EVIDENCE_HOST_WORKFLOW.get(childWorkflowId);
  await childWorkflow.terminate();
});

test("adapter versions are bound to one Supported Game, Game Profile, and source lineage", async () => {
  const mismatched = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "unrelated-source",
      adapter_version: "one-piece-en@1",
      idempotency_key: "source_adapter_mismatch_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(mismatched.status).toBe(422);
  await expect(mismatched.json()).resolves.toMatchObject({
    code: "adapter_binding_mismatch",
  });

  const constrained = await env.CATALOGUE_DB.prepare(
    `SELECT adapter_version, source_lineage, supported_game,
            game_profile_version, parser_contract, adapter_origin
     FROM source_adapter_versions ORDER BY adapter_version`,
  ).all<{
    adapter_version: string;
    source_lineage: string;
    supported_game: string;
    game_profile_version: string;
    parser_contract: string;
    adapter_origin: string;
  }>();
  expect(constrained.results).toEqual(
    sourceAdapterRegistrations
      .map((adapter) => ({
        adapter_version: adapter.adapterVersion,
        source_lineage: adapter.sourceLineage,
        supported_game: adapter.supportedGame,
        game_profile_version: adapter.gameProfileVersion,
        parser_contract: adapter.parserContract,
        adapter_origin: adapter.origin,
      }))
      .sort((left, right) =>
        left.adapter_version.localeCompare(right.adapter_version),
      ),
  );
});

test("a production plan that omits a required raw surface is rejected", async () => {
  const plan = exactOnePiecePlan("source_exact_plan_omission_001");
  plan.requests.pop();
  const response = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    plan,
  );
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toMatchObject({
    code: "incomplete_source_plan",
  });
});

test.each([
  ["cap"],
  ["pagination"],
])(
  "raw discovery %s evidence fails closed after retaining the snapshot",
  async (failure) => {
    const plan = exactOnePiecePlan(`source_exact_${failure}_001`);
    plan.requests[0]!.headers = {
      ...plan.requests[0]!.headers,
      "user-agent": `card-keepr-runtime-parser/${failure}`,
    };
    const created = await administrationRequest(
      "/v1/ingestion-runs/evidence",
      "POST",
      plan,
    );
    expect(created.status).toBe(201);
    const run = await created.json<{ id: string }>();
    const terminal = await resumeCollection(run.id, 12_000);
    expect(terminal).toMatchObject({
      state: "failed",
      failure_code: "source_parse_failed",
    });
    expect(terminal.snapshots).toHaveLength(7);
    expect(terminal.observation_sets).toHaveLength(6);
    expect(
      terminal.snapshots.some((snapshot) =>
        snapshot.request.url === plan.requests[0]!.url
      ),
    ).toBe(true);
  },
);

test("all successful response bytes stream to immutable storage while parsing stays bounded", async () => {
  const retainedRun = await createCollection(
    "source_large_parse_bound_001",
    "https://large-official-source.invalid/large-json",
    "fixture-one-piece-json-capped@1",
  );
  const retained = await resumeCollection(retainedRun.id);
  expect(retained).toMatchObject({
    state: "failed",
    failure_code: "source_parse_too_large",
  });
  expect(retained.snapshots).toHaveLength(1);
  expect(retained.snapshots[0]!.content.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(retained.snapshots[0]!.content.byte_length).toBeGreaterThan(
    1024 * 1024,
  );
  expect(retained.observation_sets).toEqual([]);

  const hugeRun = await createCollection(
    "source_huge_capture_001",
    "https://large-official-source.invalid/huge-json",
    "fixture-one-piece-json-capped@1",
  );
  const huge = await resumeCollection(hugeRun.id);
  expect(huge).toMatchObject({
    state: "failed",
    failure_code: "source_parse_too_large",
  });
  expect(huge.snapshots).toHaveLength(1);
  expect(huge.snapshots[0]!.content.byte_length).toBeGreaterThan(
    32 * 1024 * 1024,
  );
  expect(huge.snapshots[0]!.content.digest).toMatch(/^[a-f0-9]{64}$/);
}, 15_000);

test("body streaming failures are durable diagnostics with bounded retries", async () => {
  const run = await createCollection(
    "source_body_failure_001",
    "https://body-failure-official-source.invalid/body-failure",
  );
  const accepted = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const failed = await waitForEvidenceRun(run.id, "failed", 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
    })),
  ).toEqual([
    { attempt_number: 1, outcome: "body_failure" },
    { attempt_number: 2, outcome: "body_failure" },
    { attempt_number: 3, outcome: "body_failure" },
    { attempt_number: 4, outcome: "body_failure" },
  ]);
}, 15_000);

test("R2 recovery outages become durable bounded storage failures", async () => {
  const run = await createCollection(
    "source_recovery_r2_outage_001",
    "https://official-source.invalid/cards",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();
  const outageBucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (
        property === "get" ||
        property === "put" ||
        property === "createMultipartUpload"
      ) {
        return async () => {
          throw new Error("synthetic R2 outage");
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
      outageBucket,
      env.OFFICIAL_SOURCE_TRANSPORT,
      evidenceRun,
      request,
      prepared,
    );
    expect(result.kind).toBe(attempt === 4 ? "done" : "wait");
  }

  const failed = await resumeCollection(run.id);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(
    failed.diagnostics.map((diagnostic) => diagnostic.outcome),
  ).toEqual([
    "storage_failure",
    "storage_failure",
    "storage_failure",
    "storage_failure",
  ]);
});

test("resume recovers the deterministic object after an upload-before-D1 restart boundary", async () => {
  const run = await createCollection(
    "source_restart_boundary_001",
    "https://restart-official-source.invalid/must-not-refetch",
  );
  const identity = await captureOperationIdentity(
    run.id,
    "required-source",
    1,
  );
  const bytes = new TextEncoder().encode(
    '{"cards":[{"card_number":"OP01-001"}]}',
  );
  await env.EVIDENCE_OBJECTS.put(identity.objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  const now = new Date().toISOString();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations (
      attempt_id, ingestion_run_id, request_id, attempt_number,
      source_snapshot_id, content_object_key, state, requested_at,
      completed_at, request_headers_json, http_status,
      response_headers_json, response_vary_json, media_type
    ) VALUES (
      ?, ?, 'required-source', 1, ?, ?, 'response_received', ?,
      ?, '{}', 200, '{"content-type":"application/json"}', '[]',
      'application/json'
    )`,
  )
    .bind(
      identity.attemptId,
      run.id,
      identity.snapshotId,
      identity.objectKey,
      now,
      now,
    )
    .run();

  const completed = await resumeCollection(run.id);
  expect(completed).toMatchObject({
    state: "parsing",
    diagnostics: [{ attempt_number: 1, outcome: "success" }],
    snapshots: [
      {
        id: identity.snapshotId,
        content: { object_key: identity.objectKey },
      },
    ],
  });
  const operation = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_digest, content_byte_length
     FROM source_capture_operations WHERE attempt_id = ?`,
  )
    .bind(identity.attemptId)
    .first<{
      state: string;
      content_digest: string;
      content_byte_length: number;
    }>();
  expect(operation).toMatchObject({
    state: "finalized",
    content_byte_length: bytes.byteLength,
    content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).not.toBeNull();
});

test("reparse retries recover one staged immutable observation set while new intents append", async () => {
  const run = await createCollection(
    "source_collection_reparse_001",
    "https://official-source.invalid/raw-one-piece-products",
  );
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  const originalSet = completed.observation_sets[0];
  if (snapshot === undefined || originalSet === undefined) {
    throw new Error("missing evidence for reparse");
  }
  const objectsBeforeReparse = new Set(
    (
      await env.EVIDENCE_OBJECTS.list({
        prefix: "source-observations/",
      })
    ).objects.map((object) => object.key),
  );

  await env.CATALOGUE_DB.prepare(
    `CREATE TRIGGER fail_observation_set_insert
     BEFORE INSERT ON source_observation_sets
     BEGIN
       SELECT RAISE(FAIL, 'synthetic_observation_d1_outage');
     END`,
  ).run();
  const interrupted = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "reparse_intent_001",
    },
  );
  expect(interrupted.status).toBe(500);
  const staged = await env.CATALOGUE_DB.prepare(
    `SELECT state, content_object_key FROM source_parse_operations
     WHERE source_snapshot_id = ? AND adapter_version = ?
       AND idempotency_key = ?`,
  )
    .bind(snapshot.id, "fixture-one-piece-json@1", "reparse_intent_001")
    .first<{ state: string; content_object_key: string }>();
  expect(staged?.state).toBe("uploaded");
  expect(
    await env.EVIDENCE_OBJECTS.head(staged!.content_object_key),
  ).not.toBeNull();
  await env.CATALOGUE_DB.prepare(
    "DROP TRIGGER fail_observation_set_insert",
  ).run();

  const retriedResponses = await Promise.all([
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@1",
        idempotency_key: "reparse_intent_001",
      },
    ),
    administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "fixture-one-piece-json@1",
        idempotency_key: "reparse_intent_001",
      },
    ),
  ]);
  expect(retriedResponses.map((response) => response.status)).toEqual([
    201,
    201,
  ]);
  const [reparsed, replayed] = await Promise.all(
    retriedResponses.map((response) => response.json<ObservationSet>()),
  );
  if (reparsed === undefined || replayed === undefined) {
    throw new Error("missing replayed Source Observation Set");
  }
  expect(reparsed).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fixture-one-piece-json@1",
    observation_count: 1,
  });
  expect(replayed).toEqual(reparsed);
  expect(reparsed.id).not.toBe(originalSet.id);
  expect(reparsed.object_key).not.toBe(originalSet.object_key);

  const appendedResponse = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    {
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "reparse_intent_002",
    },
  );
  expect(appendedResponse.status).toBe(201);
  const appended = await appendedResponse.json<ObservationSet>();
  expect(appended.id).not.toBe(reparsed.id);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(3);
  expect(shown.observation_sets).toEqual([
    originalSet,
    reparsed,
    appended,
  ]);
  const objects = await env.EVIDENCE_OBJECTS.list({
    prefix: "source-observations/",
  });
  expect(
    objects.objects
      .map((object) => object.key)
      .filter((key) => !objectsBeforeReparse.has(key))
      .sort(),
  ).toEqual(
    [reparsed, appended]
      .map((set) => set.object_key)
      .sort(),
  );
});

test("collection is sequential per hostname and different hostnames progress concurrently", async () => {
  const response = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@1",
      idempotency_key: "source_collection_pacing_001",
      requests: [
        {
          id: "first-a",
          url: "https://pacing-a-official-source.invalid/sequence/1",
        },
        {
          id: "second-a",
          url: "https://pacing-a-official-source.invalid/sequence/2",
        },
        {
          id: "first-b",
          url: "https://pacing-b-official-source.invalid/sequence/1",
        },
        {
          id: "second-b",
          url: "https://pacing-b-official-source.invalid/sequence/2",
        },
      ],
    },
  );
  const run = await response.json<{ id: string }>();
  const completed = await resumeCollection(run.id);
  expect(completed.state).toBe("parsing");
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [
      attempt.request_id,
      Date.parse(attempt.requested_at),
    ]),
  );
  expect(attempts["second-a"]! - attempts["first-a"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(attempts["second-b"]! - attempts["first-b"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(
    Math.abs(attempts["first-a"]! - attempts["first-b"]!),
  ).toBeLessThan(500);
});

function administrationRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]!}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

type Snapshot = {
  id: string;
  request: { method: string; url: string };
  retrieval: { retrieved_at: string; fetch_attempt_id: string };
  http: { status: number; headers: Record<string, string> };
  content: { digest: string; object_key: string; byte_length: number };
  adapter_version: string;
  ingestion_run_id: string;
  reused_source_snapshot_id: string | null;
};

type ObservationSet = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  content_digest: string;
  object_key: string;
  observation_count: number;
};

type Diagnostic = {
  request_id: string;
  attempt_number: number;
  requested_at: string;
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
  diagnostic?: string | null;
};

type CollectionDocument = {
  id: string;
  state: string;
  linked_run_id: string | null;
  failure_code: string | null;
  snapshots: Snapshot[];
  observation_sets: ObservationSet[];
  diagnostics: Diagnostic[];
  workflow: { parent_id: string | null; child_ids: string[] };
};

async function createCollection(
  idempotencyKey: string,
  url: string,
  adapterVersion = "fixture-one-piece-json@1",
  headers: Record<string, string> = {},
): Promise<CollectionDocument> {
  const response = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: adapterVersion,
      idempotency_key: idempotencyKey,
      requests: [{ id: "required-source", url, headers }],
    },
  );
  expect(response.status).toBe(201);
  return response.json<CollectionDocument>();
}

async function fixtureEvidenceRequest(body: {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  requests: {
    id: string;
    url: string;
    headers?: Record<string, string>;
  }[];
}): Promise<Response> {
  return Response.json(
    await startEvidenceRun(env.CATALOGUE_DB, body, "synthetic_fixture"),
    { status: 201 },
  );
}

function exactOnePiecePlan(idempotencyKey: string) {
  return {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@1",
    idempotency_key: idempotencyKey,
    requests: officialSourceDiscoveryRequests("one-piece-en").map(
      (request) => ({ ...request }),
    ),
  };
}

async function waitForEvidenceDiagnostic(
  runId: string,
  timeoutMs = 2_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (current.diagnostics.length > 0) return current;
    if (Date.now() >= deadline) {
      throw new Error(`Ingestion Run ${runId} did not record a diagnostic`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForEvidenceCondition(
  runId: string,
  condition: (current: CollectionDocument) => boolean,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (condition(current)) return current;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach test condition: ${
          JSON.stringify(current)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForWorkflowStatus(
  instanceId: string,
  readStatus: () => Promise<{ status: string }>,
  expectedStatus: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = await readStatus();
      if (status.status === expectedStatus) return;
    } catch {
      // The deterministic handle can exist before createBatch reaches it.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Workflow ${instanceId} did not reach ${expectedStatus}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForParseOperation(
  runId: string,
  expectedState: string,
  timeoutMs = 8_000,
): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const operation = await env.CATALOGUE_DB.prepare(
      `SELECT state FROM source_parse_operations
       WHERE intent = 'collection' AND source_snapshot_id IN (
         SELECT source_snapshot_id FROM source_requests
         WHERE ingestion_run_id = ?
       )`,
    )
      .bind(runId)
      .first<{ state: string }>();
    if (operation?.state === expectedState) return operation;
    if (Date.now() >= deadline) {
      throw new Error(
        `Parse operation for ${runId} did not reach ${expectedState}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function resumeCollection(
  runId: string,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  return waitForEvidenceRun(runId, null, timeoutMs);
}

async function waitForEvidenceRun(
  runId: string,
  expectedState: "parsing" | "failed" | null = null,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (
      expectedState === null
        ? current.state === "parsing" || current.state === "failed"
        : current.state === expectedState
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach ${expectedState ?? "a terminal collection-phase state"}; current state is ${current.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function releaseActiveRunForNextScenario(): Promise<D1Result<unknown>> {
  return env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
}

async function showCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/evidence`,
    "GET",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}
