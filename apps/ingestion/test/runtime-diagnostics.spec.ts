import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import {
  productionSourceFixtureMarker,
  productionSourceFixtureRole,
  productionSourceFixtureSurface,
} from "./production-source-fixture-routing";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

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

test("evidence run diagnostics retain safe adapter, workflow, coverage, and retry references", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "diagnostic-evidence-run",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  expect(response.status).toBe(201);
  const run = await response.json<Record<string, unknown>>();
  const requestLog = JSON.parse(records.at(-1) ?? "null") as {
    request: { id: string };
  };
  expect(run).toMatchObject({
    operational_diagnostics: {
      contract: "card-keepr-operational-diagnostics@1",
      references: {
        request_id: requestLog.request.id,
        adapter_versions: ["one-piece-en@6"],
        workflow: {
          parent_id: null,
          child_ids: [],
        },
        recovery: { status_path: "/v1/status" },
      },
      terminal_evidence: {
        failure: null,
        coverage: {
          evidence_plan_count: 1,
          source_snapshot_count: 0,
          source_observation_set_count: 0,
          fetch_attempt_count: 0,
        },
      },
      retry: null,
    },
  });
  const bundle = JSON.stringify(run.operational_diagnostics);
  expect(bundle).not.toContain("diagnostic-evidence-run");
  expect(bundle).not.toContain("authorization");
  expect(bundle).not.toContain("fixture-official-source");
});

test("terminal evidence diagnostics expose collection retry guidance without a stale candidate path", async () => {
  const records: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    records.push(String(value));
  });
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "terminal-evidence-diagnostics",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  const run = await created.json<{ id: string }>();
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'failed', terminal_at = ?,
         failure_code = 'source_request_retries_exhausted'
     WHERE id = ?`,
  )
    .bind("2026-08-05T00:00:00.000Z", run.id)
    .run();
  const shown = await administrationRequest(`/v1/ingestion-runs/${run.id}`, "GET");
  expect(shown.status).toBe(200);
  const document = await shown.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    operational_diagnostics: {
      retry: {
        code: "evidence_collection_retry_available",
        source_run_id: run.id,
        method: "POST",
        path: `/v1/ingestion-runs/${run.id}/collection/retry`,
      },
      diagnosis_sequence: [
        { code: "check_status", method: "GET", path: "/v1/status" },
        {
          code: "inspect_run",
          method: "GET",
          path: `/v1/ingestion-runs/${run.id}`,
        },
        {
          code: "retry_evidence_collection",
          method: "POST",
          path: `/v1/ingestion-runs/${run.id}/collection/retry`,
        },
      ],
    },
  });
  expect(JSON.stringify(document.operational_diagnostics)).not.toContain(`/v1/ingestion-runs/${run.id}/candidate`);
  await env.CATALOGUE_DB.prepare("UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1").run();
  const retried = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/retry`, "POST", {
    idempotency_key: "terminal-evidence-diagnostics-retry",
  });
  expect(retried.status).toBe(201);
  const retryDocument = await retried.json<Record<string, unknown>>();
  const retryLog = records
    .map((record) => JSON.parse(record))
    .reverse()
    .find(
      (record: { request?: { route?: string; id?: string } }) =>
        record.request?.route === "/v1/ingestion-runs/:ref/collection/retry",
    );
  expect(retryDocument).toMatchObject({
    linked_run_id: run.id,
    operational_diagnostics: {
      references: { request_id: retryLog.request.id },
    },
  });
  expect(JSON.stringify(retryDocument.operational_diagnostics)).not.toContain("terminal-evidence-diagnostics-retry");
});

test("published evidence diagnostics explicitly advertise no retry route", async () => {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "published-evidence-diagnostics",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  const source = await created.json<{ id: string }>();
  const run = { id: "run_published_evidence_diagnostics" };
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare("UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1"),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         operational_request_id, terminal_at, candidate_json
       ) VALUES (
         ?, 'published', '["one-piece"]', ?, 'catrev_spine_000', NULL, ?,
         ?, ?, '{}'
       )`,
    ).bind(
      run.id,
      "2026-08-05T00:00:00.000Z",
      "published-evidence-diagnostics-row",
      "published-evidence-request",
      "2026-08-05T00:00:00.000Z",
    ),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       )
       SELECT ?, source_lineage, supported_game, game_profile_version,
              adapter_version, request_plan_json, plan_origin
       FROM ingestion_evidence_plans WHERE ingestion_run_id = ?`,
    ).bind(run.id, source.id),
  ]);
  const shown = await administrationRequest(`/v1/ingestion-runs/${run.id}`, "GET");
  expect(shown.status).toBe(200);
  const document = await shown.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    operational_diagnostics: {
      retry_available: false,
      retry: null,
    },
  });
  const diagnostics = JSON.stringify(document.operational_diagnostics);
  expect(diagnostics).not.toContain("/collection/retry");
  expect(diagnostics).not.toContain(`/v1/ingestion-runs/${run.id}/retry`);
});

test("production source fixture selection is invariant under retries and reordering", () => {
  const discoveryHeaders = new Headers({
    accept: "text/html",
  });
  const surfaceHeaders = new Headers({
    accept: "text/html",
    "user-agent": "card-keepr-official-source/1; request-role=surface",
  });
  expect([surfaceHeaders, discoveryHeaders, discoveryHeaders, surfaceHeaders].map(productionSourceFixtureRole)).toEqual(
    ["surface", "retained-discovery", "retained-discovery", "surface"],
  );
  expect(
    productionSourceFixtureMarker(
      new Headers({
        "user-agent": "card-keepr-representable-legality-v3; request-role=listing",
      }),
    ),
  ).toBe("card-keepr-representable-legality-v3");
  const products = new Headers({
    "user-agent": "card-keepr-products-v3; request-role=surface; request-surface=products",
  });
  const releases = new Headers({
    "user-agent": "card-keepr-products-v3; request-role=surface; request-surface=releases",
  });
  expect([releases, products, releases, products].map(productionSourceFixtureSurface)).toEqual([
    "releases",
    "products",
    "releases",
    "products",
  ]);
  expect(productionSourceFixtureMarker(products)).toBe("card-keepr-products-v3");
  expect(
    productionSourceFixtureMarker(
      new Headers({
        "user-agent": "card-keepr-representable-legality-v3; request-role=surface",
      }),
    ),
  ).toBe("card-keepr-representable-legality-v3");
});
