import type { ExtractedSourceRequest } from "../adapters";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { archiveParseProgress, advanceArchiveDiscovery, type ArchiveParseProgress } from "./source-archive-repository";
import { sealedSourceRecordProgress, sourceRecordInitialDigest, sourceRecordNextDigest } from "./source-record-intake";
import { sourceRecordPage, type SourceRecordRow } from "./source-record-repository";
import {
  appendDiscoveredEvidenceRequests,
  type EvidenceRequestRow,
  type IngestionEvidenceRow,
} from "./source-evidence-repository";

/** Discover at most 512 sealed observations, retaining the verified ordinal/digest cursor. */
export async function discoverArchiveRequestsBatch(
  db: CatalogueStore,
  run: IngestionEvidenceRow,
  request: EvidenceRequestRow,
  set: string,
  guard: () => D1PreparedStatement,
) {
  const records = await sealedSourceRecordProgress(db, set);
  let progress = await archiveParseProgress(db, set).first<ArchiveParseProgress>();
  if (!records || !progress || progress.state === "normalizing")
    throw new Error("Archive discovery requires sealed observations.");
  if (progress.state === "complete") return true;
  let digest =
    progress.discovery_ordinal === 0
      ? await sourceRecordInitialDigest(set, records.header_json)
      : progress.discovery_digest;
  if (!digest) throw new Error("Archive discovery prefix is missing.");
  let processed = 0;
  while (progress.discovery_ordinal < records.next_ordinal && processed < 512) {
    const rows = (
      await sourceRecordPage(
        db,
        set,
        progress.discovery_ordinal - 1,
        Math.min(8, 512 - processed),
      ).all<SourceRecordRow>()
    ).results;
    if (!rows.length) throw new Error("Archive discovery source records are incomplete.");
    let ordinal = progress.discovery_ordinal;
    const requests: ExtractedSourceRequest[] = [];
    for (const row of rows) {
      if (row.ordinal !== ordinal++ || (await sha256Text(row.content)) !== row.sha256)
        throw new Error("Archive discovery source record integrity failed.");
      digest = await sourceRecordNextDigest(digest, row);
      const retained: unknown = JSON.parse(row.request_json);
      if (retained !== null) {
        const selected = Array.isArray(retained) ? retained : [retained];
        if (selected.length > 16) throw new Error("Archive source request count is unbounded.");
        requests.push(...(selected as ExtractedSourceRequest[]));
      }
    }
    await appendDiscoveredEvidenceRequests(db, run, request, requests, guard);
    await db.batch([guard(), advanceArchiveDiscovery(db, set, progress.discovery_ordinal, ordinal, digest, false)]);
    const next = await archiveParseProgress(db, set).first<ArchiveParseProgress>();
    if (
      !next ||
      next.discovery_ordinal !== ordinal ||
      next.discovery_digest !== digest ||
      canonicalJson({
        ...next,
        discovery_ordinal: progress.discovery_ordinal,
        discovery_digest: progress.discovery_digest,
      }) !== canonicalJson(progress)
    )
      throw new Error("Archive discovery cursor changed.");
    progress = next;
    processed += rows.length;
  }
  if (progress.discovery_ordinal < records.next_ordinal) return false;
  if (digest !== records.digest) throw new Error("Archive discovery final digest changed.");
  await db.batch([
    guard(),
    advanceArchiveDiscovery(db, set, progress.discovery_ordinal, progress.discovery_ordinal, digest, true),
  ]);
  return (await archiveParseProgress(db, set).first<ArchiveParseProgress>())?.state === "complete";
}
