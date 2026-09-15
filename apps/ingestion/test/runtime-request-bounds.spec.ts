import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequestPage,
  pendingEvidenceHostShards,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  officialCollectionRequestsFromDiscovery,
} from "../../../src/catalogue/source-evidence";
import { canonicalJson, utf8 } from "../../../src/catalogue/shared";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  createCollection,
  fusionWorldDiscoveryRecords,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

test.each([
  {
    hostname: "official-source.invalid",
    urls: [
      "https://OFFICIAL-SOURCE.invalid:443/cards",
      "https://official-source.invalid:8443/cards",
      "https://official-source.invalid:9443/cards",
    ],
  },
  {
    hostname: "[2001:db8::1]",
    urls: [
      "https://[2001:0db8:0:0:0:0:0:1]:443/cards",
      "https://[2001:db8::1]:8443/cards",
      "https://[2001:db8::1]:9443/cards",
    ],
  },
])("host scheduling and child capture share the canonical hostname $hostname", async ({ hostname, urls }) => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "source_port_hostname_collection_001",
    requests: urls.map((url, index) => ({ id: `cards-${index}`, method: "GET", url })),
  });
  const runId = String(started.id);
  const db = catalogueStore(env.CATALOGUE_DB);
  expect(await pendingEvidenceHostShards(db, runId)).toEqual([
    { hostname, minimum_sequence_number: 0, pending_request_count: 3, pending_shard_count: 1 },
  ]);
  const completed = await resumeCollection(runId);
  expect(completed.collection_completed_at).not.toBeNull();
  expect(completed.snapshots.map(({ request }) => request.url).sort()).toEqual(
    urls.map((url) => new URL(url).href).sort(),
  );
  expect(completed.observation_sets).toHaveLength(3);
  expect(completed.workflow.child_ids).toHaveLength(1);
  expect(await pendingEvidenceHostShards(db, runId)).toEqual([]);
});

test("host scheduling retains bounded next-shard receipts across completed prefixes", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json@2",
    idempotency_key: "source_next_host_shard_receipts_001",
    requests: [{ id: "root", method: "GET", url: "https://official-source.invalid/cards/0" }],
  });
  const runId = String(started.id);
  const db = catalogueStore(env.CATALOGUE_DB);
  const run = await requiredEvidenceRun(db, runId);
  const [root] = await pendingEvidenceRequests(db, runId);
  if (!root) throw new Error("Pending root missing");
  for (let offset = 0; offset < 201; offset += 100) {
    await appendDiscoveredEvidenceRequests(
      db,
      run,
      root,
      Array.from({ length: Math.min(100, 201 - offset) }, (_, index) => ({
        role: "detail" as const,
        url: `https://${offset + index === 200 ? "second-source.invalid" : "official-source.invalid"}/cards/${offset + index + 1}`,
        headers: { accept: "application/json" },
      })),
    );
  }
  const first = await pendingEvidenceHostShards(db, runId);
  expect(first).toEqual([
    {
      hostname: "official-source.invalid",
      minimum_sequence_number: 0,
      pending_request_count: 200,
      pending_shard_count: 2,
    },
    {
      hostname: "second-source.invalid",
      minimum_sequence_number: 200,
      pending_request_count: 1,
      pending_shard_count: 1,
    },
  ]);
  await sourceEvidenceQueries.completeFirstEvidenceHostShard(env.CATALOGUE_DB).bind(runId).run();
  expect(await pendingEvidenceHostShards(db, runId)).toEqual([
    {
      hostname: "official-source.invalid",
      minimum_sequence_number: 200,
      pending_request_count: 1,
      pending_shard_count: 1,
    },
    {
      hostname: "second-source.invalid",
      minimum_sequence_number: 200,
      pending_request_count: 1,
      pending_shard_count: 1,
    },
  ]);
  expect(utf8(canonicalJson(first)).byteLength).toBeLessThan(1024);
  expect(await pendingEvidenceRequestPage(db, runId, -1, Number.MAX_SAFE_INTEGER, 100)).toHaveLength(2);
});

test("host scheduling admits a bounded host page without skipping the remaining host", async () => {
  const run = await createCollection("source_host_page_continuation_001", "https://official-source.invalid/cards");
  const db = catalogueStore(env.CATALOGUE_DB);
  const stored = await requiredEvidenceRun(db, run.id);
  const [root] = await pendingEvidenceRequests(db, run.id);
  if (!root) throw new Error("Pending root missing");
  await appendDiscoveredEvidenceRequests(
    db,
    stored,
    root,
    Array.from({ length: 100 }, (_, index) => ({
      role: "detail" as const,
      url: `https://source-${String(index).padStart(3, "0")}.invalid/cards`,
      headers: { accept: "application/json" },
    })),
  );
  const first = await pendingEvidenceHostShards(db, run.id);
  expect(first).toHaveLength(100);
  expect(
    first.every(
      ({ pending_request_count, pending_shard_count }) => pending_request_count === 1 && pending_shard_count === 1,
    ),
  ).toBe(true);
  await sourceEvidenceQueries
    .completeSelectedEvidenceHosts(env.CATALOGUE_DB)
    .bind(run.id, JSON.stringify(first.map(({ hostname }) => hostname)))
    .run();
  const remaining = await pendingEvidenceHostShards(db, run.id);
  expect(remaining).toHaveLength(1);
  expect(first.some(({ hostname }) => hostname === remaining[0]!.hostname)).toBe(false);
  const requests = await pendingEvidenceRequestPage(db, run.id, -1, Number.MAX_SAFE_INTEGER, 100);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).hostname).toBe(remaining[0]!.hostname);
});

test("each request uses its owning Evidence Plan adapter capture cap", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "source_per_plan_capture_bound_001",
    plans: [
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@2",
        requests: [
          {
            id: "large-cap-first-plan",
            method: "GET",
            url: "https://official-source.invalid/cards",
          },
        ],
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json-capped@1",
        requests: [
          {
            id: "small-cap-second-plan",
            method: "GET",
            url: "https://large-official-source.invalid/large-json",
          },
        ],
      },
    ],
  });
  if (typeof started.id !== "string") throw new Error("run id missing");
  const failed = await resumeCollection(started.id, 15_000);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
  });
  expect(failed.snapshots.some(({ request }) => request.url.endsWith("/large-json"))).toBe(false);
});

test("dynamic discovery rejects oversized request identities before Workflow scheduling", async () => {
  const run = await createCollection("source_dynamic_identity_bound_001", "https://official-source.invalid/cards");
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await expect(
    appendDiscoveredEvidenceRequests(catalogueStore(env.CATALOGUE_DB), storedRun, root, [
      {
        role: "detail",
        url: `https://official-source.invalid/cards/${"x".repeat(2_100)}`,
        headers: { accept: "text/html" },
      },
    ]),
  ).rejects.toMatchObject({ code: "source_discovery_failed" });
  expect(
    await sourceEvidenceQueries.countSourceDiscoveryRequestPlansCount(env.CATALOGUE_DB).bind(run.id).first("count"),
  ).toBe(0);
});

test("final Official Source requests keep discovery evidence immutable while exposing a deterministic fixture role", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const requests = await officialCollectionRequestsFromDiscovery(adapter, records, {
    "user-agent": "card-keepr-card-content-v3",
  });

  expect(records.every(({ headers }) => canonicalJson(headers) === canonicalJson({ accept: "text/html" }))).toBe(true);
  expect(requests).toHaveLength(adapter.requiredSurfaces?.length ?? 0);
  expect(
    requests.map(({ surface, headers }) => ({
      surface,
      headers,
    })),
  ).toEqual(
    requests.map(({ surface }) => ({
      surface,
      headers: {
        accept: "text/html",
        "user-agent": `card-keepr-card-content-v3; request-role=surface; request-surface=${surface}`,
      },
    })),
  );
});

test("final Official Source requests canonicalize injected reserved routing metadata", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const requests = await officialCollectionRequestsFromDiscovery(adapter, fusionWorldDiscoveryRecords(), {
    "user-agent": "caller-agent; request-surface=releases; request-role=detail; request-surface=products",
  });

  for (const { surface, headers } of requests) {
    expect(headers["user-agent"]).toBe(`caller-agent; request-role=surface; request-surface=${surface}`);
  }
});

test("final Official Source collection identities enforce the URL byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const withFirstUrl = (url: string) =>
    records.map((record, index) =>
      index === 0
        ? {
            ...record,
            url,
            discovered_from: { ...record.discovered_from, url },
          }
        : record,
    );
  const urlPrefix = "https://www.dbs-cardgame.com/fw/en/cardlist/";
  const boundedUrl = (bytes: number) => `${urlPrefix}${"x".repeat(bytes - utf8(urlPrefix).byteLength)}`;

  await expect(officialCollectionRequestsFromDiscovery(adapter, withFirstUrl(boundedUrl(2_048)))).resolves.toHaveLength(
    records.length,
  );
  await expect(officialCollectionRequestsFromDiscovery(adapter, withFirstUrl(boundedUrl(2_049)))).rejects.toMatchObject(
    { code: "source_discovery_failed" },
  );
});

test("final Official Source collection identities enforce the merged-header byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const headerBase = utf8(
    canonicalJson({
      accept: "text/html",
      "user-agent": "card-keepr-official-source/1; request-role=surface; request-surface=card-search",
      "x-final-bound": "",
    }),
  ).byteLength;
  await expect(
    officialCollectionRequestsFromDiscovery(adapter, records, { "x-final-bound": "x".repeat(2_048 - headerBase) }),
  ).resolves.toHaveLength(records.length);
  await expect(
    officialCollectionRequestsFromDiscovery(adapter, records, { "x-final-bound": "x".repeat(2_049 - headerBase) }),
  ).rejects.toMatchObject({ code: "source_discovery_failed" });
});

test("maximum admitted request pages retain a Workflow result safety margin", async () => {
  const run = await createCollection("source_workflow_page_byte_bound_001", "https://official-source.invalid/cards");
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    catalogueStore(env.CATALOGUE_DB),
    storedRun,
    root,
    Array.from({ length: 99 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/${String(index).padStart(2, "0")}/${"x".repeat(1_950)}`,
      headers: { "user-agent": "u".repeat(1_900) },
    })),
  );
  const page = await pendingEvidenceRequestPage(
    catalogueStore(env.CATALOGUE_DB),
    run.id,
    -1,
    Number.MAX_SAFE_INTEGER,
    100,
  );
  expect(page).toHaveLength(100);
  expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(512 * 1024);
});
