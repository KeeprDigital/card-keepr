import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/source-adapters";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  administrationRequest,
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  resumeCollection,
  waitForEvidenceCondition,
  waitForWorkflowStatus,
} from "./runtime-helpers";

installRuntimeSuite();

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
    const adapter = requiredSourceAdapter(adapterVersion);
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
  "the authenticated API rejects cross-version reparsing from $fixture to $adapter",
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

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });
  },
);

test("authenticated reparse requires the exact Digimon snapshot capture version even when versions share URL authority", async () => {
  const current = requiredSourceAdapter("digimon-en@6");
  const historical = requiredSourceAdapter("digimon-en@3");
  const currentDiscoveryUrl = current.requestUrlForDiscovery?.();
  const historicalCardListUrl = historical.requestUrlForSurface?.(
    "card-list",
  );
  if (currentDiscoveryUrl === undefined || historicalCardListUrl === undefined) {
    throw new Error("Digimon versioned URL contracts are unavailable");
  }
  expect(currentDiscoveryUrl).toBe(historicalCardListUrl);
  const superseded = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@5",
      idempotency_key: "reject-superseded-digimon-v5-source",
      requests: officialSourceDiscoveryRequests("digimon-en"),
    },
  );
  expect(superseded.status).toBe(422);
  await expect(superseded.json()).resolves.toMatchObject({
    code: "adapter_not_supported",
  });
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@6",
      idempotency_key: "digimon-exact-capture-version-source",
      requests: officialSourceDiscoveryRequests("digimon-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    "POST",
  );
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(
    accepted.workflow.id,
  );
  const completed = await waitForEvidenceCondition(
    run.id,
    (currentRun) => currentRun.snapshots.some(({ request }) =>
      request.url === currentDiscoveryUrl
    ),
    12_000,
  );
  const snapshot = completed.snapshots.find(({ request }) =>
    request.url === currentDiscoveryUrl
  );
  if (snapshot === undefined) throw new Error("retained Digimon snapshot missing");
  try {
    expect(snapshot.adapter_version).toBe("digimon-en@6");

    const mismatched = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "digimon-en@5",
        idempotency_key: "digimon-mismatched-capture-version-reparse",
      },
    );
    expect(mismatched.status).toBe(422);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });

    const exact = await administrationRequest(
      `/v1/source-snapshots/${snapshot.id}/observations`,
      "POST",
      {
        adapter_version: "digimon-en@6",
        idempotency_key: "digimon-exact-capture-version-reparse",
      },
    );
    expect(exact.status).toBe(201);
    await expect(exact.json()).resolves.toMatchObject({
      source_snapshot_id: snapshot.id,
      adapter_version: "digimon-en@6",
    });
  } finally {
    await waitForWorkflowStatus(
      accepted.workflow.id,
      () => parent.status(),
      "complete",
      90_000,
    );
    const candidateResponse = await administrationRequest(
      `/v1/ingestion-runs/${run.id}/candidate`,
      "GET",
    );
    expect(candidateResponse.status).toBe(200);
    const candidate = await candidateResponse.json<{
      candidate_digest: string;
    }>();
    const rejected = await administrationRequest(
      `/v1/ingestion-runs/${run.id}/rejection`,
      "POST",
      {
        candidate_digest: candidate.candidate_digest,
        idempotency_key: "digimon-exact-capture-version-cleanup",
      },
    );
    expect(rejected.status).toBe(200);
  }
}, 120_000);
