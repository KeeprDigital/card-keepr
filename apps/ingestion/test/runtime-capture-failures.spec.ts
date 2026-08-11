import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  captureOperationIdentity,
  parseCapturedRequest,
} from "../../../src/catalogue/source-evidence-capture";
import {
  installedSourceAdapterRegistrations,
} from "../../../src/catalogue/source-adapters";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import { sha256, utf8 } from "../../../src/catalogue/serialization";
import retainedFusionWorldDiscovery from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-restructured-card-search.json";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  type CollectionDocument,
  createCollection,
  exactOnePiecePlan,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
  showCollection,
  waitForEvidenceDiagnostic,
  waitForEvidenceRun,
} from "./runtime-helpers";

installRuntimeSuite();

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
      expect(response.status).toBe(201);
      const run = await response.json<CollectionDocument>();
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
  await clearActiveRunForNextScenario();

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
  await clearActiveRunForNextScenario();

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
  await clearActiveRunForNextScenario();
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

test("adapter registrations stay constrained while mismatched production identities fail closed", async () => {
  const mismatched = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "unrelated-source",
      adapter_version: "one-piece-en@6",
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
    installedSourceAdapterRegistrations
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

test("a production plan cannot replace its discovery root with a raw surface", async () => {
  const plan = exactOnePiecePlan("source_exact_plan_omission_001");
  plan.requests[0]!.id = "one-piece-en:card-list";
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
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const plan = exactOnePiecePlan(
        `source_exact_${failure}_${String(repetition).padStart(3, "0")}`,
      );
      plan.requests[0]!.headers = {
        ...plan.requests[0]!.headers,
        "user-agent": `card-keepr-runtime-parser/${failure}-${repetition}`,
      };
      const created = await administrationRequest(
        "/v1/ingestion-runs/evidence",
        "POST",
        plan,
      );
      expect(created.status).toBe(201);
      const run = await created.json<{ id: string }>();
      const terminal = await resumeCollection(run.id, 20_000);
      if (terminal.failure_code !== "source_parse_failed") {
        const failures = await env.CATALOGUE_DB.prepare(
          `SELECT request_id, state, failure_code
           FROM source_requests
           WHERE ingestion_run_id = ? AND failure_code IS NOT NULL
           ORDER BY sequence_number`,
        ).bind(run.id).all();
        throw new Error(JSON.stringify({
          failure_code: terminal.failure_code,
          source_failures: failures.results,
        }));
      }
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: "source_parse_failed",
      });
      expect(terminal.snapshots).toHaveLength(11);
      expect(terminal.observation_sets).toHaveLength(10);
      expect(
        terminal.snapshots.some((snapshot) =>
          snapshot.request.url === plan.requests[0]!.url
        ),
      ).toBe(true);
      await expect(env.CATALOGUE_DB.prepare(
        `SELECT request_id, failure_code FROM source_requests
         WHERE ingestion_run_id = ? AND state = 'failed'
         ORDER BY sequence_number`,
      ).bind(run.id).all()).resolves.toMatchObject({
        results: [{
          request_id: "one-piece-en:card-list",
          failure_code: "source_parse_failed",
        }],
      });
    }
  },
  90_000,
);

test.each([
  ["declared", "large-json"],
  ["chunked", "oversized-chunked-json"],
])(
  "%s oversized response bodies fail before an immutable snapshot is retained",
  async (shape, path) => {
    const run = await createCollection(
      `source_${shape}_capture_bound_001`,
      `https://large-official-source.invalid/${path}`,
      "fixture-one-piece-json-capped@1",
    );
    const failed = await resumeCollection(run.id, 15_000);
    expect(failed).toMatchObject({
      state: "failed",
      failure_code: "source_request_retries_exhausted",
      snapshots: [],
      observation_sets: [],
    });
    expect(failed.diagnostics.map(({ outcome }) => outcome)).toEqual([
      "body_failure",
      "body_failure",
      "body_failure",
      "body_failure",
    ]);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const identity = await captureOperationIdentity(
        run.id,
        "required-source",
        attempt,
      );
      expect(await env.EVIDENCE_OBJECTS.head(identity.objectKey)).toBeNull();
    }
  },
  30_000,
);

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

// Retain one captured Official Source response so the capture path can parse
// it without a live publisher fetch.
async function retainProductionSnapshot(
  runId: string,
  requestId: string,
  url: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = await sha256(bytes);
  const snapshotId = `srcsnap_${digest}`;
  const fetchId = `srcfetch_${digest}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_fetch_attempts (
         id, ingestion_run_id, request_id, attempt_number,
         requested_at, completed_at, outcome, http_status,
         response_headers_json, retry_after_ms, diagnostic
       ) VALUES (?, ?, ?, 1, '2026-08-07T00:00:00.000Z',
         '2026-08-07T00:00:01.000Z', 'success', 200, '{}', NULL, NULL)`,
    ).bind(fetchId, runId, requestId),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_snapshots (
         id, ingestion_run_id, request_id, fetch_attempt_id,
         request_method, request_url, request_headers_json,
         representation_fingerprint, response_vary_json, retrieved_at,
         http_status, response_headers_json, media_type, content_digest,
         content_byte_length, content_object_key, source_lineage,
         supported_game, game_profile_version, adapter_version,
         reused_source_snapshot_id
       ) VALUES (?, ?, ?, ?, 'GET', ?, ?, ?, '[]',
         '2026-08-07T00:00:01.000Z', 200, '{}', 'text/html', ?, ?, ?,
         'fusion-world-en', 'fusion-world', 'fusion-world@1',
         'fusion-world-en@6', NULL)`,
    ).bind(
      snapshotId,
      runId,
      requestId,
      fetchId,
      url,
      JSON.stringify({ accept: "text/html" }),
      digest,
      digest,
      bytes.byteLength,
      objectKey,
    ),
  ]);
  return snapshotId;
}

test("production discovery that proves no collection surface fails its last discovery stage closed", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@6",
      idempotency_key: "official_collection_plan_empty_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");

  // The retained discovery root proves its publisher navigation, so it plans
  // its stage requests and cannot yet freeze a Collection Plan.
  await parseCapturedRequest(
    env.CATALOGUE_DB,
    env.EVIDENCE_OBJECTS,
    storedRun,
    root,
    await retainProductionSnapshot(
      run.id,
      root.request_id,
      root.url,
      Buffer.from(retainedFusionWorldDiscovery.body_base64, "base64"),
    ),
  );

  const staged = await pendingEvidenceRequests(env.CATALOGUE_DB, run.id);
  const cards = staged.find(({ request_id }) =>
    request_id.startsWith("fusion-world-en:listing:cards:")
  );
  if (cards === undefined) throw new Error("cards discovery stage is absent");
  // Every other discovery stage completes without proving a collection
  // surface, leaving the cards stage as the run's last outstanding request.
  await env.CATALOGUE_DB.prepare(
    `UPDATE source_requests SET state = 'observed'
     WHERE ingestion_run_id = ? AND request_id != ?`,
  ).bind(run.id, cards.request_id).run();

  const stageSnapshotId = await retainProductionSnapshot(
    run.id,
    cards.request_id,
    cards.url,
    utf8("<html><title>BANDAI DRAGON BALL CARD LIST</title><main>Cards</main></html>"),
  );
  await expect(parseCapturedRequest(
    env.CATALOGUE_DB,
    env.EVIDENCE_OBJECTS,
    storedRun,
    cards,
    stageSnapshotId,
  )).resolves.toMatchObject({
    kind: "done",
    failure_code: "official_collection_plan_empty",
  });
  await expect(env.CATALOGUE_DB.prepare(
    `SELECT request_id, state, failure_code FROM source_requests
     WHERE ingestion_run_id = ? AND failure_code IS NOT NULL`,
  ).bind(run.id).all()).resolves.toMatchObject({
    results: [{
      request_id: cards.request_id,
      state: "failed",
      failure_code: "official_collection_plan_empty",
    }],
  });
  await expect(env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM official_source_collection_plans
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first<{ count: number }>()).resolves.toMatchObject({
    count: 0,
  });
});
