import { env } from "cloudflare:workers";
import { expect } from "vitest";
import {
  parseCapturedRequest,
} from "../../../src/catalogue/source-evidence-capture";
import {
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import { sha256, utf8 } from "../../../src/catalogue/serialization";
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
         'fusion-world-en@9', NULL)`,
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
    env.CATALOGUE_DB.prepare(
      `UPDATE source_requests SET state = 'captured', source_snapshot_id = ?
       WHERE ingestion_run_id = ? AND request_id = ? AND state = 'pending'`,
    ).bind(snapshotId, runId, requestId),
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
    env.CATALOGUE_DB.prepare(
      `WITH RECURSIVE filler(n) AS (
         SELECT 1 UNION ALL SELECT n + 1 FROM filler WHERE n < ?2
       )
       INSERT INTO source_discovery_request_plans (
         ingestion_run_id, request_id, sequence_number, parent_request_id,
         method, url, request_headers_json, representation_fingerprint,
         request_role
       )
       SELECT ?1, 'fusion-world-en:detail:' || printf('%08d', n), 1000 + n,
              ?3, 'GET',
              'https://www.dbs-cardgame.com/fw/en/cardlist/detail/' || n,
              '{}', printf('%064x', n), 'detail'
       FROM filler`,
    ).bind(runId, fusionWorldRequestCapacity - 1, parentRequestId),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state,
         source_snapshot_id, failure_code, request_role,
         discovered_from_request_id
       )
       SELECT ingestion_run_id, request_id, sequence_number, method, url,
              request_headers_json, representation_fingerprint, ?2,
              NULL, NULL, request_role, parent_request_id
       FROM source_discovery_request_plans
       WHERE ingestion_run_id = ?1
         AND request_id LIKE 'fusion-world-en:detail:%'`,
    ).bind(runId, fillerState),
  ]);
}

// Stage a fusion-world-en@9 run whose Source Lineage already holds exactly
// its request capacity, then parse the retained captured discovery root so
// the derived overflow batch is rejected and the run pauses.
export async function pauseRunAtCapacity(
  idempotencyKey: string,
  fillerState: "pending" | "observed" = "pending",
) {
  const created = await administrationRequest(
    "/v1/ingestion-runs/evidence",
    "POST",
    {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@9",
      idempotency_key: idempotencyKey,
      requests: officialSourceDiscoveryRequests("fusion-world-en"),
    },
  );
  expect(created.status).toBe(201);
  const run = await created.json<{ id: string }>();
  const storedRun = await requiredEvidenceRun(env.CATALOGUE_DB, run.id);
  const root = (await pendingEvidenceRequests(env.CATALOGUE_DB, run.id))[0];
  if (root === undefined) throw new Error("discovery root request is absent");
  await fillLineageToCapacity(run.id, root.request_id, fillerState);
  const snapshotId = await retainCapturedDiscoveryRoot(
    run.id,
    root.request_id,
    root.url,
    Buffer.from(retainedFusionWorldDiscovery.body_base64, "base64"),
  );
  await expect(parseCapturedRequest(
    env.CATALOGUE_DB,
    env.EVIDENCE_OBJECTS,
    storedRun,
    root,
    snapshotId,
  )).resolves.toMatchObject({ kind: "done", failure_code: null });
  return { runId: run.id, storedRun, root, snapshotId };
}
