import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/source-adapters";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequestPage,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  officialCollectionRequestsFromDiscovery,
} from "../../../src/catalogue/source-evidence-model";
import { canonicalJson, utf8 } from "../../../src/catalogue/serialization";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  productionRepresentableFusionLegalityResponse,
} from "./production-source-fixture-routing";
import {
  createCollection,
  fusionWorldDiscoveryRecords,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

test("each request uses its owning Evidence Plan adapter capture cap", async () => {
  const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "source_per_plan_capture_bound_001",
    plans: [
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@1",
        requests: [{
          id: "large-cap-first-plan",
          method: "GET",
          url: "https://official-source.invalid/cards",
        }],
      },
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json-capped@1",
        requests: [{
          id: "small-cap-second-plan",
          method: "GET",
          url: "https://large-official-source.invalid/large-json",
        }],
      },
    ],
  });
  if (typeof started.id !== "string") throw new Error("run id missing");
  const failed = await resumeCollection(
    started.id,
    15_000,
  );
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
  });
  expect(failed.snapshots.some(({ request }) =>
    request.url.endsWith("/large-json")
  )).toBe(false);
});

test("dynamic discovery rejects oversized request identities before Workflow scheduling", async () => {
  const run = await createCollection(
    "source_dynamic_identity_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await expect(appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    [{
      role: "detail",
      url: `https://official-source.invalid/cards/${"x".repeat(2_100)}`,
      headers: { accept: "text/html" },
    }],
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM source_discovery_request_plans
     WHERE ingestion_run_id = ?`,
  ).bind(run.id).first("count")).toBe(0);
});

test("final Official Source requests keep discovery evidence immutable while exposing a deterministic fixture role", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "user-agent": "card-keepr-representable-legality-v3" },
  );

  expect(records.every(({ headers }) =>
    canonicalJson(headers) === canonicalJson({ accept: "text/html" })
  )).toBe(true);
  expect(requests).toHaveLength(adapter.requiredSurfaces?.length ?? 0);
  expect(requests.map(({ surface, headers }) => ({
    surface,
    headers,
  }))).toEqual(requests.map(({ surface }) => ({
    surface,
    headers: {
      accept: "text/html",
      "user-agent":
        `card-keepr-representable-legality-v3; request-role=surface; request-surface=${surface}`,
    },
  })));
});

test("final Official Source requests canonicalize injected reserved routing metadata", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    fusionWorldDiscoveryRecords(),
    {
      "user-agent":
        "caller-agent; request-surface=releases; request-role=detail; request-surface=products",
    },
  );

  for (const { surface, headers } of requests) {
    expect(headers["user-agent"]).toBe(
      `caller-agent; request-role=surface; request-surface=${surface}`,
    );
  }
});

test("the exact live Fusion final request selects and parses the representable legality fixture", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const requests = await officialCollectionRequestsFromDiscovery(
    adapter,
    fusionWorldDiscoveryRecords(),
    { "user-agent": "card-keepr-representable-legality-v3" },
  );
  const current = requests.find(({ surface }) =>
    surface === "legality-current"
  );
  if (current === undefined) throw new Error("current Legality request missing");
  expect(current.url).toBe(
    "https://www.dbs-cardgame.com/fw/en/news/01_305.html",
  );
  expect(current.headers["user-agent"]).toBe(
    "card-keepr-representable-legality-v3; request-role=surface; request-surface=legality-current",
  );

  const response = productionRepresentableFusionLegalityResponse(
    new Request(current.url, { headers: current.headers }),
  );
  expect(response).not.toBeNull();
  const bytes = new Uint8Array(await response!.arrayBuffer());
  const html = new TextDecoder().decode(bytes);
  expect(html).toContain("fusion-world-card-game-legality-current-data");
  expect(html).toContain('class="restriction-card"');
  const observations = await adapter.parseBytes?.(bytes, {
    mediaType: response!.headers.get("content-type"),
    url: current.url,
    requestId: current.id,
  });
  const legality = observations?.find((observation) =>
    typeof observation === "object" && observation !== null &&
    (observation as Record<string, unknown>).observation_type ===
      "legality_rules"
  ) as Record<string, unknown> | undefined;
  expect(legality?.completeness).toEqual({
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  });
  expect(legality?.legality_rules).toEqual([
    expect.objectContaining({
      id: "fw_production_eligible",
      official_wording:
        "FB01-001 is eligible 'as printed' – publisher–confirmed &#39;literal&#39;.",
      card_numbers: ["FB01-001"],
      effect: { type: "eligible" },
    }),
  ]);

  expect(productionRepresentableFusionLegalityResponse(new Request(
    "https://www.dbs-cardgame.com/fw/en/rules/banned-limited-cards/",
    { headers: current.headers },
  ))).toBeNull();
});

test("final Official Source collection identities enforce the URL byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const withFirstUrl = (url: string) => records.map((record, index) =>
    index === 0
      ? {
        ...record,
        url,
        discovered_from: { ...record.discovered_from, url },
      }
      : record
  );
  const urlPrefix = "https://www.dbs-cardgame.com/fw/en/cardlist/";
  const boundedUrl = (bytes: number) =>
    `${urlPrefix}${"x".repeat(bytes - utf8(urlPrefix).byteLength)}`;

  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    withFirstUrl(boundedUrl(2_048)),
  )).resolves.toHaveLength(records.length);
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    withFirstUrl(boundedUrl(2_049)),
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
});

test("final Official Source collection identities enforce the merged-header byte bound", async () => {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const records = fusionWorldDiscoveryRecords();
  const headerBase = utf8(canonicalJson({
    accept: "text/html",
    "user-agent":
      "card-keepr-official-source/1; request-role=surface; request-surface=legality-current",
    "x-final-bound": "",
  })).byteLength;
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "x-final-bound": "x".repeat(2_048 - headerBase) },
  )).resolves.toHaveLength(records.length);
  await expect(officialCollectionRequestsFromDiscovery(
    adapter,
    records,
    { "x-final-bound": "x".repeat(2_049 - headerBase) },
  )).rejects.toMatchObject({ code: "source_discovery_failed" });
});

test("maximum admitted request pages retain a Workflow result safety margin", async () => {
  const run = await createCollection(
    "source_workflow_page_byte_bound_001",
    "https://official-source.invalid/cards",
  );
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("pending discovery root missing");
  await appendDiscoveredEvidenceRequests(
    env.CATALOGUE_DB,
    storedRun,
    root,
    Array.from({ length: 99 }, (_, index) => ({
      role: "detail" as const,
      url: `https://official-source.invalid/cards/${String(index).padStart(2, "0")}/${"x".repeat(1_950)}`,
      headers: { "user-agent": "u".repeat(1_900) },
    })),
  );
  const page = await pendingEvidenceRequestPage(
    env.CATALOGUE_DB,
    run.id,
    -1,
    Number.MAX_SAFE_INTEGER,
    100,
  );
  expect(page).toHaveLength(100);
  expect(new TextEncoder().encode(JSON.stringify(page)).byteLength)
    .toBeLessThan(512 * 1024);
});
