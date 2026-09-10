import { waitForDispatchedNativeCandidates } from "./native-candidate-helpers";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { requiredSourceAdapter, officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
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

test.each([
  {
    adapter: "fixture-one-piece-json-capped@1",
    fixture: "fixture-one-piece-json@3",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "fixture-one-piece-json@3",
    fixture: "fixture-one-piece-json-capped@1",
    game: "one-piece",
    lineage: "one-piece-en",
  },
  {
    adapter: "fixture-fusion-world-json-large@1",
    fixture: "fixture-fusion-world-json@2",
    game: "fusion-world",
    lineage: "fusion-world-en",
  },
  {
    adapter: "fixture-fusion-world-json@2",
    fixture: "fixture-fusion-world-json-large@1",
    game: "fusion-world",
    lineage: "fusion-world-en",
  },
  {
    adapter: "digimon-en@7",
    fixture: "fixture-digimon-json@2",
    game: "digimon",
    lineage: "digimon-en",
  },
  {
    adapter: "gundam-en-asia@7",
    fixture: "fixture-gundam-en-asia-json@2",
    game: "gundam",
    lineage: "gundam-en-asia",
  },
  {
    adapter: "gundam-en-us@7",
    fixture: "fixture-gundam-en-us-json@2",
    game: "gundam",
    lineage: "gundam-en-us",
  },
])(
  "the authenticated API rejects cross-version reparsing from $fixture to $adapter",
  async ({ adapter, fixture, game, lineage }) => {
    // Both versions are installed on the same Source Lineage; a Source
    // Snapshot is parsed only by its exact capturing version.
    expect(requiredSourceAdapter(adapter).sourceLineage).toBe(lineage);
    const created = await fixtureEvidenceRequest({
      supported_game: game,
      source_lineage: lineage,
      adapter_version: fixture,
      idempotency_key: `cross-version-reparse-source-${fixture}-${adapter}`,
      requests: [
        {
          id: `source-${adapter}`,
          url: "https://official-source.invalid/cards",
        },
      ],
    });
    expect(created.status).toBe(201);
    const run = await created.json<CollectionDocument>();
    const completed = await resumeCollection(run.id);
    const snapshot = completed.snapshots[0];
    if (snapshot === undefined) throw new Error("retained snapshot missing");

    const response = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: adapter,
      idempotency_key: `cross-version-reparse-intent-${fixture}-${adapter}`,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });
  },
);

test("authenticated reparse requires the exact Digimon snapshot capture version", async () => {
  const current = requiredSourceAdapter("digimon-en@7");
  // fixture-digimon-json@2 is the installed synthetic fixture version on
  // the same lineage; digimon-en@6 is no longer registered at all (ADR 0008).
  const unrelated = requiredSourceAdapter("fixture-digimon-json@2");
  const currentDiscoveryUrl = current.requestUrlForDiscovery?.();
  if (currentDiscoveryUrl === undefined) {
    throw new Error("Digimon versioned URL contracts are unavailable");
  }
  expect(unrelated.sourceLineage).toBe("digimon-en");
  expect(unrelated.parse).toBeTypeOf("function");
  const unregistered = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@6",
    idempotency_key: "reject-unregistered-digimon-v6-source",
    requests: officialSourceDiscoveryRequests("digimon-en"),
  });
  expect(unregistered.status).toBe(422);
  await expect(unregistered.json()).resolves.toMatchObject({
    code: "adapter_not_supported",
  });
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@7",
    idempotency_key: "digimon-exact-capture-version-source",
    requests: officialSourceDiscoveryRequests("digimon-en"),
  });
  expect(created.status).toBe(201);
  const run = await created.json<CollectionDocument>();
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  const accepted = await resumed.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id);
  const completed = await waitForEvidenceCondition(
    run.id,
    (currentRun) => currentRun.snapshots.some(({ request }) => request.url === currentDiscoveryUrl),
    12_000,
  );
  const snapshot = completed.snapshots.find(({ request }) => request.url === currentDiscoveryUrl);
  if (snapshot === undefined) throw new Error("retained Digimon snapshot missing");
  try {
    expect(snapshot.adapter_version).toBe("digimon-en@7");

    // An installed version on the same lineage that did not capture the
    // snapshot is refused by the capture-version check.
    const mismatched = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: "fixture-digimon-json@2",
      idempotency_key: "digimon-mismatched-capture-version-reparse",
    });
    expect(mismatched.status).toBe(422);
    await expect(mismatched.json()).resolves.toMatchObject({
      code: "source_snapshot_adapter_mismatch",
    });

    // A version that is not registered at all is refused before the
    // capture-version check.
    const unknown = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: "digimon-en@6",
      idempotency_key: "digimon-unregistered-capture-version-reparse",
    });
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toMatchObject({
      code: "adapter_not_supported",
    });

    const exact = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/observations`, "POST", {
      adapter_version: "digimon-en@7",
      idempotency_key: "digimon-exact-capture-version-reparse",
    });
    expect(exact.status).toBe(201);
    await expect(exact.json()).resolves.toMatchObject({
      source_snapshot_id: snapshot.id,
      adapter_version: "digimon-en@7",
    });
  } finally {
    await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 90_000);
    const [candidate] = await waitForDispatchedNativeCandidates(run.id, 1);
    const rejected = await administrationRequest(`/v1/game-candidates/${candidate!.id}/abandon`, "POST", {
      generation: candidate!.generation,
      idempotency_key: "digimon-exact-capture-version-cleanup",
    });
    expect(rejected.status).toBe(200);
  }
}, 120_000);
