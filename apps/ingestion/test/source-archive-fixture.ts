import { env } from "cloudflare:workers";
import chillerpillar from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/chillerpillar.json?raw";
import art from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/art-chillerpillar.json?raw";
import delver from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/delver.json?raw";
import token from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/token.json?raw";
import split from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/split-three.json?raw";
import normal from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/normal.json?raw";
import etched from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import { requiredSourceAdapter, sourceAdapterForCoverage } from "../../../src/catalogue/adapters";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import type { SnapshotRow } from "../../../src/catalogue/source-evidence/source-evidence-repository-types";
import * as queries from "./query-helpers/source-archive";

export const version = "scryfall-magic-en@1";
export const raw = utf8(
  [chillerpillar, art, delver, token, split, normal, etched]
    .map((line) => (line.endsWith("\n") ? line : `${line}\n`))
    .join(""),
);

export async function seedArchive(key: string, corrupt = false, input = raw, adapterVersion = version) {
  const db = catalogueStore(env.CATALOGUE_DB),
    adapter = sourceAdapterForCoverage(requiredSourceAdapter(adapterVersion), "representative-english-paper");
  const compressed = new Uint8Array(
    await new Response(new Blob([input]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
  if (corrupt) compressed[compressed.length - 8]! ^= 1;
  const result = await startEvidenceRun(db, {
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: adapterVersion,
    subset: "representative-english-paper",
    idempotency_key: key,
    requests: adapter.requiredSurfaces!.map((surface) => ({
      id: `scryfall-magic-en:${surface}`,
      url: adapter.requestUrlForSurface!(surface),
    })),
  });
  const run = await requiredEvidenceRun(db, String(result.id));
  const [root] = await pendingEvidenceRequests(db, run.id);
  if (!root) throw new Error("Source root missing");
  const [request] = await appendDiscoveredEvidenceRequests(db, run, root, [
    {
      role: "listing",
      discoveryKey: `bulk-20260914090527-${compressed.length}`,
      url: "https://data.scryfall.io/default-cards/default-cards-20260914090527.jsonl.gz",
      headers: { accept: "application/gzip", "accept-encoding": "identity" },
    },
  ]);
  if (!request) throw new Error("Archive request missing");
  const id = `snapshot-${key}`,
    objectKey = `source-snapshots/${id}`,
    at = "2026-09-14T10:00:00.000Z";
  await db.batch([
    queries.insertArchiveFixtureAttempt(db).bind(id, run.id, request.request_id, 1, at, at, "success", "{}"),
    queries
      .insertArchiveFixtureSnapshot(db)
      .bind(
        id,
        run.id,
        request.request_id,
        id,
        "GET",
        request.url,
        request.request_headers_json,
        request.representation_fingerprint,
        "[]",
        at,
        200,
        "{}",
        "application/gzip",
        await sha256(compressed),
        compressed.length,
        objectKey,
        adapter.sourceLineage,
        adapter.supportedGame,
        adapter.gameProfileVersion,
        adapter.adapterVersion,
      ),
    queries.markArchiveFixtureCaptured(db).bind(id, run.id, request.request_id),
  ]);
  await env.EVIDENCE_OBJECTS.put(objectKey, compressed);
  const snapshot = await queries.archiveFixtureSnapshot(db).bind(id).first<SnapshotRow>();
  if (!snapshot) throw new Error("Archive snapshot missing");
  return {
    db,
    run,
    snapshot,
    request,
    pin: adapter.archiveExtraction!.pin({
      url: request.url,
      requestId: request.request_id,
      compressedBytes: compressed.length,
    }),
  };
}
