import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import { type CatalogueStore, sha256 } from "../shared";
import type { SnapshotRow } from "./source-evidence-repository-types";
import { retainedParentSnapshotStatement } from "./source-parse-repository";
import {
  parseContextStatement,
  retainedContextParentsStatement,
  retainContextParentStatement,
  sealParseContextStatement,
} from "./source-parent-context-repository";

type ParentSnapshot = SnapshotRow & { request_role: string; discovered_from_request_id: string | null };

/** Walk immutable request edges; never select a latest response or a same-URL response from another run. */
export async function retainedParentContext(
  db: CatalogueStore,
  bucket: R2Bucket,
  snapshot: ParentSnapshot,
  adapter: SourceAdapterRegistration,
  operationId: string,
) {
  const bounds = adapter.retainedParentContext;
  if (!bounds) return undefined;
  if (
    !Number.isSafeInteger(bounds.maximumDepth) ||
    bounds.maximumDepth < 1 ||
    bounds.maximumDepth > 3 ||
    !Number.isSafeInteger(bounds.maximumTotalBytes) ||
    bounds.maximumTotalBytes < 1 ||
    bounds.maximumTotalBytes > 3 * 1024 * 1024
  )
    throw new Error("Source Adapter retained parent context bounds are invalid.");
  if (await parseContextStatement(db, operationId).first())
    return boundParents(db, bucket, snapshot, adapter, operationId);
  const parents: ParentSnapshot[] = [];
  let next = snapshot.discovered_from_request_id;
  let totalBytes = 0;
  const seen = new Set([snapshot.request_id]);
  while (next !== null) {
    if (seen.has(next) || parents.length >= bounds.maximumDepth)
      throw new AdapterParseFailure("Source discovery ancestry is cyclic or exceeds its bounded depth.");
    seen.add(next);
    const candidates = (
      await retainedParentSnapshotStatement(db, snapshot.ingestion_run_id, next).all<
        ParentSnapshot & { selected_snapshot_id: string | null }
      >()
    ).results;
    const parent = candidates.length === 1 ? candidates[0] : undefined;
    if (
      !parent ||
      parent.selected_snapshot_id !== parent.id ||
      parent.source_lineage !== snapshot.source_lineage ||
      parent.adapter_version !== snapshot.adapter_version ||
      parent.supported_game !== snapshot.supported_game ||
      parent.game_profile_version !== snapshot.game_profile_version ||
      parent.request_role === "image"
    )
      throw new AdapterParseFailure("Source discovery parent has no complete matching retained evidence.");
    totalBytes += parent.content_byte_length;
    if (parent.content_byte_length > adapter.maximumSnapshotBytes || totalBytes > bounds.maximumTotalBytes)
      throw new AdapterParseFailure("Source discovery parent context exceeds its retained byte bound.");
    parents.push(parent);
    next = parent.discovered_from_request_id;
  }
  await db.batch([
    ...parents.map((parent, ordinal) => retainContextParentStatement(db, operationId, ordinal, parent.id)),
    sealParseContextStatement(db, operationId, parents.length, bounds.maximumTotalBytes),
  ]);
  return boundParents(db, bucket, snapshot, adapter, operationId);
}

async function boundParents(
  db: CatalogueStore,
  bucket: R2Bucket,
  snapshot: ParentSnapshot,
  adapter: SourceAdapterRegistration,
  operation: string,
) {
  const context = await parseContextStatement(db, operation).first<{
    dependency_count: number;
    maximum_context_bytes: number;
  }>();
  const rows = (await retainedContextParentsStatement(db, operation).all<ParentSnapshot & { ordinal: number }>())
    .results;
  if (!context || rows.length !== context.dependency_count || rows.length > adapter.retainedParentContext!.maximumDepth)
    throw new Error("Sealed Source discovery context is incomplete or exceeds its bound.");
  const parents = [];
  let next = snapshot.discovered_from_request_id;
  let totalBytes = 0;
  for (const [ordinal, parent] of rows.entries()) {
    totalBytes += parent.content_byte_length;
    if (
      parent.ordinal !== ordinal ||
      parent.request_id !== next ||
      parent.ingestion_run_id !== snapshot.ingestion_run_id ||
      parent.source_lineage !== snapshot.source_lineage ||
      parent.adapter_version !== snapshot.adapter_version ||
      parent.supported_game !== snapshot.supported_game ||
      parent.game_profile_version !== snapshot.game_profile_version ||
      parent.request_role === "image" ||
      parent.content_byte_length > adapter.maximumSnapshotBytes ||
      totalBytes > context.maximum_context_bytes ||
      totalBytes > adapter.retainedParentContext!.maximumTotalBytes
    )
      throw new Error("Sealed Source discovery context changed its exact retained ancestry.");
    parents.push({
      requestId: parent.request_id,
      snapshotId: parent.id,
      role: parent.request_role,
      url: parent.request_url,
      mediaType: parent.media_type,
      retrievedAt: parent.retrieved_at,
      contentSha256: parent.content_digest,
      bytes: await verifiedParentBytes(bucket, parent),
    });
    next = parent.discovered_from_request_id;
  }
  if (next !== null) throw new Error("Sealed Source discovery context does not contain its complete ancestry.");
  return parents;
}

async function verifiedParentBytes(bucket: R2Bucket, snapshot: SnapshotRow) {
  const object = await bucket.get(snapshot.content_object_key);
  if (!object || object.size !== snapshot.content_byte_length)
    throw new Error("Source discovery parent bytes are unavailable or truncated.");
  const bytes = new Uint8Array(snapshot.content_byte_length);
  const reader = object.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.byteLength)
        throw new Error("Source discovery parent length changed.");
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (length !== bytes.byteLength || (await sha256(bytes)) !== snapshot.content_digest)
    throw new Error("Source discovery parent bytes failed digest verification.");
  return bytes;
}
