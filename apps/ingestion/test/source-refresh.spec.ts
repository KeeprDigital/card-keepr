import { waitForDispatchedNativeCandidates } from "./native-candidate-helpers";
import { expect, test } from "vitest";
import { administrationRequest, installRuntimeSuite, resumeCollection, waitForEvidenceRun } from "./runtime-helpers";

installRuntimeSuite();

test.each([
  {
    subset: "public-english-inventory",
    area: "catalogue",
    surface: "catalogue",
    url: "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200",
  },
  {
    subset: "origins-errata",
    area: "errata",
    surface: "errata",
    url: "https://playriftbound.com/en-us/news/rules-and-releases/riftbound-origins-card-errata/",
  },
  {
    subset: "announced-products-2027",
    area: "catalogue",
    surface: "products",
    url: "https://playriftbound.com/en-us/news/announcements/products-and-sets-into-2027/",
  },
])("Riot collection pins the owner's registered $subset scope", async ({ subset, area, surface, url }) => {
  const body = {
    plans: [
      {
        supported_game: "riftbound",
        source_lineage: "riftbound-en",
        adapter_version: "riftbound-en@1",
        subset,
        requests: [
          {
            id: `riftbound-en:${surface}`,
            url,
          },
        ],
      },
    ],
    idempotency_key: "riftbound-inventory-subset",
  };
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", body);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    evidence_plans: [{ coverage: { locale: "en", area, subset } }],
  });
  body.plans[0]!.subset = "unregistered-inventory";
  body.idempotency_key = "riftbound-unregistered-subset";
  expect((await administrationRequest("/v1/ingestion-runs/evidence", "POST", body)).status).toBe(422);
});

// Synthetic transport plans: these tests establish policy, not real-source coverage.
const plan = {
  supported_game: "one-piece",
  source_lineage: "one-piece-en",
  adapter_version: "fixture-one-piece-json@3",
  requests: [{ id: "one-piece-en:cards", url: "https://cards.example.invalid/facts" }],
};

test("refresh participation is fixed before collection and cannot change on replay", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans: [{ ...plan, participation: "required" }],
    idempotency_key: "declared-refresh",
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    evidence_plans: [{ participation: "required", coverage: { locale: "en", area: "catalogue", subset: "complete" } }],
  });
  const changed = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans: [{ ...plan, participation: "optional" }],
    idempotency_key: "declared-refresh",
  });
  expect(changed.status).toBe(409);
});

test("an optional source outage retains its failed attempt without blocking the required source", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans: [
      {
        ...plan,
        requests: [{ id: "one-piece-en:discovery", url: "https://official-source.invalid/reconciliation/base" }],
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@2",
        participation: "optional",
        requests: [{ id: "fusion-world-en:discovery", url: "https://official-source.invalid/missing-optional" }],
      },
    ],
    idempotency_key: "optional-outage",
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  await resumeCollection(id);
  await waitForDispatchedNativeCandidates(id, 2, 8_000, { "fusion-world": "failed", "one-piece": "sealed" });
  const result = await waitForEvidenceRun(id, "parsing");
  expect(result.state).toBe("parsing");
  expect(result).toMatchObject({
    source_coverage: [
      {
        source_lineage: "one-piece-en",
        status: "complete",
        successful_checked_at: expect.any(String),
        content_captured_at: expect.any(String),
      },
      {
        source_lineage: "fusion-world-en",
        status: "incomplete",
        successful_checked_at: null,
        content_captured_at: null,
      },
    ],
  });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ http_status: 404 }));
});

test("a missing required capture after a full batch cannot publish or claim a successful scope check", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...plan,
    idempotency_key: "partial-required-after-batch",
    requests: Array.from({ length: 9 }, (_, index) => ({
      id: `one-piece-en:${index === 0 ? "discovery" : `page${index}`}`,
      url:
        index === 8
          ? "https://official-source.invalid/missing-required"
          : `https://official-source.invalid/reconciliation/base?p=${index}`,
    })),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  await resumeCollection(id, 20_000);
  const result = await waitForEvidenceRun(id, "failed");
  expect(result).toMatchObject({
    state: "failed",
    source_coverage: [
      {
        planned_requests: 9,
        observed_requests: 8,
        successful_checked_at: null,
        status: "incomplete",
      },
    ],
  });
  const subset = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...plan,
    subset: "first-eight-pages",
    idempotency_key: "unproven-narrower-scope",
  });
  expect(subset.status).toBe(422);
});

test("retiring a source is explicit, replayable and cannot retire a designated authority", async () => {
  const decision = {
    state: "retired",
    expected_generation: "0",
    rationale: "Source stopped publishing",
    idempotency_key: "retire-limitless",
  };
  const retired = await administrationRequest("/v1/source-lineages/limitless-one-piece-en/lifecycle", "POST", decision);
  expect(retired.status).toBe(200);
  expect(await retired.json()).toMatchObject({
    source_lineage: "limitless-one-piece-en",
    state: "retired",
    generation: 1,
  });
  expect(
    (await administrationRequest("/v1/source-lineages/limitless-one-piece-en/lifecycle", "POST", decision)).status,
  ).toBe(200);
  const blocked = await administrationRequest("/v1/source-lineages/one-piece-en/lifecycle", "POST", {
    ...decision,
    idempotency_key: "retire-authority",
  });
  expect(blocked.status).toBe(409);
  const startRetired = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...plan,
    source_lineage: "limitless-one-piece-en",
    adapter_version: "fixture-limitless-json@1",
    idempotency_key: "retired-plan",
  });
  expect(startRetired.status).toBe(409);
  const authority = await administrationRequest("/v1/source-authorities", "POST", {
    game: "one-piece",
    locale: "en",
    release_region: "OCEANIA",
    area: "card_facts",
    source_lineage: "limitless-one-piece-en",
    expected_generation: "0",
    rationale: "Must not select retired source",
    idempotency_key: "retired-authority",
  });
  expect(authority.status).toBe(409);
  const restored = await administrationRequest("/v1/source-lineages/limitless-one-piece-en/lifecycle", "POST", {
    ...decision,
    state: "active",
    expected_generation: "1",
    idempotency_key: "reactivate-limitless",
  });
  expect(restored.status).toBe(200);
  const history = await administrationRequest("/v1/source-lineages/limitless-one-piece-en/lifecycle", "GET");
  expect(await history.json()).toMatchObject({
    state: "active",
    generation: 2,
    history: [{ state: "active" }, { state: "retired" }],
  });
});
