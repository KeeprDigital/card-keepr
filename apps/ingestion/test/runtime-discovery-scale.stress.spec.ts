import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  canonicalJson,
  sha256,
  utf8,
} from "../../../src/catalogue/serialization";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  administrationRequest,
  type CollectionDocument,
  createCollection,
  installRuntimeSuite,
  showCollection,
  waitForEvidenceCondition,
} from "./runtime-helpers";

installRuntimeSuite();

test("dynamic discovery durably plans and replays 2,500 requests within D1 limits", async () => {
  const run = await createCollection(
    "source_dynamic_plan_d1_limit_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const parentRequest = (
    await pendingEvidenceRequests(env.CATALOGUE_DB, run.id)
  )[0];
  if (parentRequest === undefined) {
    throw new Error("pending discovery parent request missing");
  }
  const discovered = Array.from({ length: 2_500 }, (_, index) => ({
    role: "detail" as const,
    url: `https://official-source.invalid/cards/${String(index + 1).padStart(4, "0")}`,
    headers: { accept: "text/html" },
  }));

  expect(await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    discovered,
  )).toHaveLength(2_500);
  expect(await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    parentRequest,
    discovered,
  )).toHaveLength(2_500);

  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(2_500);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(2_501);
}, 60_000);

test("dynamic discovery scopes each Source Adapter Version capacity to its owning Evidence Plan", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "source_dynamic_per_plan_bound_001",
    plans: [
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@1",
        requests: [{
          id: "fusion-root",
          method: "GET",
          url: "https://official-source.invalid/fusion/root",
        }],
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@1",
        requests: [{
          id: "one-piece-root",
          method: "GET",
          url: "https://official-source.invalid/one-piece/root",
        }],
      },
    ],
  });
  const runId = started.id;
  if (typeof runId !== "string") throw new Error("run id missing");
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, runId);
  const roots = await pendingEvidenceRequests(env.CATALOGUE_DB, runId);
  for (const [lineage, root] of [
    ["fusion-world-en", roots.find(({ request_id }) => request_id === "fusion-root")],
    ["one-piece-en", roots.find(({ request_id }) => request_id === "one-piece-root")],
  ] as const) {
    if (root === undefined) throw new Error(`${lineage} root missing`);
    await expect(appendDiscoveredEvidenceRequests(
      env.CATALOGUE_DB,
      storedRun,
      root,
      Array.from({ length: 3_000 }, (_, index) => ({
        role: "detail" as const,
        url: `https://official-source.invalid/${lineage}/${String(index).padStart(4, "0")}`,
        headers: { accept: "text/html" },
      })),
    )).resolves.toHaveLength(3_000);
  }
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(6_000);
}, 90_000);

test("dynamic discovery rejects one request beyond the exact adapter capacity", async () => {
  // The fixture adapter keeps the historical 5,000-request capacity, so a
  // 5,001st unique identity in its owning Evidence Plan fails closed.
  const run = await createCollection(
    "source_dynamic_single_plan_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await expect(appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 5_001 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/bound/${String(index).padStart(4, "0")}`,
      headers: { accept: "text/html" },
    })),
  )).rejects.toMatchObject({ code: "source_discovery_too_large" });
});

test("the authenticated Workflow shards a 5,000-request host plan into bounded child workloads", async () => {
  const run = await createCollection(
    "source_workflow_shard_bound_001",
    "https://official-source.invalid/cards/root",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 4_999 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/sharded/${String(index + 1).padStart(4, "0")}`,
      headers: { accept: "application/json" },
    })),
  );

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  let observed: CollectionDocument | undefined;
  try {
    observed = await waitForEvidenceCondition(
      run.id,
      (current) => current.workflow.child_ids.length === 25,
      8_000,
    );
  } finally {
    const current = await showCollection(run.id);
    if (current.workflow.parent_id !== null) {
      await (await env.EVIDENCE_INGESTION_WORKFLOW.get(
        current.workflow.parent_id,
      )).terminate().catch(() => undefined);
    }
    const activeChildId = `evidence-host-${await sha256(utf8(canonicalJson({
      ingestion_run_id: run.id,
      hostname: "official-source.invalid",
      minimum_sequence_number: 0,
      maximum_sequence_number: 199,
    })))}`;
    await (await env.EVIDENCE_HOST_WORKFLOW.get(activeChildId)).terminate()
      .catch(() => undefined);
  }
  expect(observed?.workflow.child_ids).toHaveLength(25);
}, 90_000);

test("concurrent discovery batches cannot overrun the adapter capacity together", async () => {
  const run = await createCollection(
    "source_dynamic_concurrent_capacity_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  // Each 3,000-request batch fits the 5,000 capacity alone; together they
  // would hold 6,001 unique identities, so exactly one batch may be admitted
  // whichever way the two in-flight admissions interleave.
  const outcomes = await Promise.allSettled([
    ["left", 3_000],
    ["right", 3_000],
  ].map(([side, size]) =>
    appendDiscoveredEvidenceRequests(
      env.CATALOGUE_DB,
      storedRun,
      root,
      Array.from({ length: size as number }, (_, index) => ({
        role: "detail" as const,
        url: `https://official-source.invalid/cards/${String(side)}/${String(index).padStart(4, "0")}`,
        headers: { accept: "text/html" },
      })),
    )
  ));
  expect(
    outcomes.filter(({ status }) => status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = outcomes.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  expect(rejected?.reason).toMatchObject({
    code: "source_discovery_too_large",
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(3_001);
}, 90_000);

test("a production-shaped Fusion World graph larger than 5,000 requests is admitted into bounded host shards", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: "source_fusion_capacity_graph_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 6_000 }, (_, index) => ({
      role: "detail" as const,
      url: `https://www.dbs-cardgame.com/fw/en/cardlist/detail/FB${String(index + 1).padStart(5, "0")}`,
      headers: { accept: "text/html" },
    })),
  );
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(6_001);

  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  let observed: CollectionDocument | undefined;
  try {
    observed = await waitForEvidenceCondition(
      run.id,
      (current) => current.workflow.child_ids.length === 31,
      8_000,
    );
  } finally {
    const current = await showCollection(run.id);
    if (current.workflow.parent_id !== null) {
      await (await env.EVIDENCE_INGESTION_WORKFLOW.get(
        current.workflow.parent_id,
      )).terminate().catch(() => undefined);
    }
    const activeChildId = `evidence-host-${await sha256(utf8(canonicalJson({
      ingestion_run_id: run.id,
      hostname: "www.dbs-cardgame.com",
      minimum_sequence_number: 0,
      maximum_sequence_number: 199,
    })))}`;
    await (await env.EVIDENCE_HOST_WORKFLOW.get(activeChildId)).terminate()
      .catch(() => undefined);
  }
  expect(observed?.workflow.child_ids).toHaveLength(31);
}, 90_000);

test("a Fusion World batch beyond the fusion-world-en@9 capacity is rejected deterministically", async () => {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: "source_fusion_capacity_reject_001",
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  // The discovery root already holds one of the 15,000 unique identities, so
  // a 15,000-request discovered batch exceeds the exact adapter capacity.
  await expect(appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 15_000 }, (_, index) => ({
      role: "detail" as const,
      url: `https://www.dbs-cardgame.com/fw/en/cardlist/detail/RJ${String(index + 1).padStart(5, "0")}`,
      headers: { accept: "text/html" },
    })),
  )).rejects.toMatchObject({ code: "source_discovery_too_large" });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_requests
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(
    officialSourceDiscoveryRequests("fusion-world-en").length,
  );
}, 90_000);
