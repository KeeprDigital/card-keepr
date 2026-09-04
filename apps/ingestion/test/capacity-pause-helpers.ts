import { catalogueStore } from "../../../src/catalogue/shared";
import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  parseCapturedRequest,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/adapters";
import { sha256, utf8 } from "../../../src/catalogue/shared";
import retainedFusionWorldDiscovery from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-restructured-card-search.json";
import { administrationRequest } from "./runtime-helpers";

export const fusionWorldRequestCapacity = 15_000;

// Retain one captured Official Source response so the capture path can parse
// it without a live publisher fetch, leaving the Source Request 'captured'
// exactly as the hostname Workflow shards do before their parse step.
export async function retainCapturedDiscoveryRoot(
  runId: string,
  requestId: string,
  url: string,
  bytes: Uint8Array,
): Promise<string> {
  const digest = await sha256(bytes);
  // Identities are scoped to the run: D1 state persists across the tests in
  // this file and both scenarios retain the same discovery bytes.
  const identity = await sha256(utf8(`${runId}:${digest}`));
  const snapshotId = `srcsnap_${identity}`;
  const fetchId = `srcfetch_${identity}`;
  const objectKey = `source-snapshots/${snapshotId}.bin`;
  await env.EVIDENCE_OBJECTS.put(objectKey, bytes);
  await env.CATALOGUE_DB.batch([
    sourceEvidenceQueries
      .insertSourceFetchAttemptsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(fetchId, runId, requestId),
    sourceEvidenceQueries
      .insertSourceSnapshotsForRetainCapturedDiscoveryRoot(env.CATALOGUE_DB)
      .bind(
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
    sourceEvidenceQueries.setSourceRequestsStateSourceSnapshotId(env.CATALOGUE_DB).bind(snapshotId, runId, requestId),
  ]);
  return snapshotId;
}

// Fill the Source Lineage with retained unique request identities so the
// discovery root is the capacity-th identity. The immutable-plan trigger
// admits a source_requests row only through a matching retained discovery
// plan row, so retain those first.
export async function fillLineageToCapacity(
  runId: string,
  parentRequestId: string,
  fillerState: "pending" | "observed" = "pending",
): Promise<void> {
  await env.CATALOGUE_DB.batch([
    sourceEvidenceQueries.inspectFiller(env.CATALOGUE_DB).bind(runId, fusionWorldRequestCapacity - 1, parentRequestId),
    sourceEvidenceQueries.insertSourceRequestsForFillLineageToCapacity(env.CATALOGUE_DB).bind(runId, fillerState),
  ]);
}

// Stage a fusion-world-en@9 run whose Source Lineage already holds exactly
// its request capacity, then parse the retained captured discovery root so
// the derived overflow batch is rejected and the run pauses.
export async function pauseRunAtCapacity(idempotencyKey: string, fillerState: "pending" | "observed" = "pending") {
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@9",
    idempotency_key: idempotencyKey,
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const storedRun = await requiredEvidenceRun(catalogueStore(env.CATALOGUE_DB), run.id);
  const root = (await pendingEvidenceRequests(catalogueStore(env.CATALOGUE_DB), run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");
  await fillLineageToCapacity(run.id, root.request_id, fillerState);
  const snapshotId = await retainCapturedDiscoveryRoot(
    run.id,
    root.request_id,
    root.url,
    Buffer.from(retainedFusionWorldDiscovery.body_base64, "base64"),
  );
  await expect(
    parseCapturedRequest(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, storedRun, root, snapshotId),
  ).resolves.toMatchObject({ kind: "done", failure_code: null });
  return { runId: run.id, storedRun, root, snapshotId };
}
