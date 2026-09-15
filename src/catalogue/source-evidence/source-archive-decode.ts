import { createHash } from "node:crypto";
import { canonicalJson, sha256, sha256Text, type CatalogueStore } from "../shared";
import { gzipJsonlBlocks, type SourceArchiveLimits } from "../shared";
import {
  beginEvidenceObjectWrite,
  completeEvidenceObjectWrite,
  completeObservedEvidenceWrite,
} from "./evidence-cleanup-repository";
import { putImmutableEvidenceBytes } from "./source-evidence-object";
import {
  archiveBlock,
  archiveDecode,
  initializeArchiveDecode,
  planArchiveBlock,
  retainArchiveBlock,
  advanceArchiveDecode,
  sealArchiveDecode,
  type ArchiveBlock,
  type ArchiveDecode,
} from "./source-archive-repository";
import type { SnapshotRow } from "./source-evidence-repository-types";

const blocksPerCallback = 4;

/** At most four new blocks per call. Gzip resumes by verifying its retained prefix. */
export async function decodeArchiveBatch(
  db: CatalogueStore,
  bucket: R2Bucket,
  snapshot: SnapshotRow,
  pin: { cutoff: string; limits: SourceArchiveLimits },
  guard: () => D1PreparedStatement,
  blockRecords = 1024,
) {
  if (!Number.isSafeInteger(blockRecords) || blockRecords < 1 || blockRecords > 1024)
    throw new Error("Archive block record capacity exceeds its independent bound.");
  const pinJson = canonicalJson({
    contract: "card-keepr-source-archive@1",
    source_snapshot_id: snapshot.id,
    raw_sha256: snapshot.content_digest,
    raw_bytes: snapshot.content_byte_length,
    block_records: blockRecords,
    ...pin,
  });
  const initial = await sha256Text(canonicalJson({ snapshot: snapshot.id, pin: pinJson }));
  await db.batch([guard(), initializeArchiveDecode(db, snapshot.id, pinJson, initial)]);
  let progress = await archiveDecode(db, snapshot.id).first<ArchiveDecode>();
  if (!progress || progress.pin_json !== pinJson) throw new Error("Immutable archive pin changed.");
  if (progress.state === "decoded") return progress;
  let digest = initial,
    seen = 0,
    added = 0;
  const decodedHash = createHash("sha256");
  for await (const block of gzipJsonlBlocks(
    verifiedArchiveBytes(bucket, snapshot),
    pin.limits,
    4 * 1024 * 1024,
    blockRecords,
  )) {
    decodedHash.update(block.bytes);
    const blockDigest = await sha256(block.bytes);
    const expected: ArchiveBlock = {
      ordinal: block.ordinal,
      byte_offset: block.offset,
      first_record: block.firstRecord,
      record_count: block.recordCount,
      byte_length: block.bytes.byteLength,
      sha256: blockDigest,
      object_key: `source-derived/${snapshot.id}/gzip-jsonl-v1/${block.ordinal}-${blockDigest}.jsonl`,
      state: "retained",
    };
    digest = await sha256Text(canonicalJson({ previous: digest, ...expected }));
    seen++;
    if (block.ordinal < progress.next_block) {
      const retained = await archiveBlock(db, snapshot.id, block.ordinal).first<ArchiveBlock>();
      if (canonicalJson(retained) !== canonicalJson(expected))
        throw new Error("Archive replay changed a retained block.");
      if (seen === progress.next_block && digest !== progress.digest) throw new Error("Archive prefix digest changed.");
      continue;
    }
    if (added === blocksPerCallback) return progress;
    if (block.ordinal !== progress.next_block) throw new Error("Archive block cursor changed.");
    await db.batch([guard(), planArchiveBlock(db, snapshot.id, expected)]);
    const planned = await archiveBlock(db, snapshot.id, block.ordinal).first<ArchiveBlock>();
    if (canonicalJson({ ...planned, state: "retained" }) !== canonicalJson(expected))
      throw new Error("Archive block declaration changed.");
    const token = crypto.randomUUID();
    const observed = await putImmutableEvidenceBytes(
      bucket,
      expected.object_key,
      block.bytes,
      blockDigest,
      token,
      async () => {
        await db.batch([
          guard(),
          beginEvidenceObjectWrite(db, token, snapshot.ingestion_run_id, expected.object_key, new Date().toISOString()),
        ]);
      },
      "application/x-ndjson",
    );
    if (observed && observed !== token)
      await completeObservedEvidenceWrite(
        db,
        observed,
        snapshot.ingestion_run_id,
        expected.object_key,
        new Date().toISOString(),
      ).run();
    await completeEvidenceObjectWrite(db, token, new Date().toISOString()).run();
    await db.batch([
      guard(),
      retainArchiveBlock(db, snapshot.id, block.ordinal),
      advanceArchiveDecode(db, snapshot.id, progress, expected, digest),
    ]);
    progress = await archiveDecode(db, snapshot.id).first<ArchiveDecode>();
    if (!progress || progress.next_block !== seen || progress.digest !== digest)
      throw new Error("Archive decode progress changed.");
    added++;
  }
  // Only normal EOF verifies the complete raw digest and gzip trailer. Prefix
  // receipts alone never authorize normalization or reconciliation.
  if (seen !== progress.next_block || digest !== progress.digest || progress.next_record === 0)
    throw new Error("Archive completion is empty or inconsistent.");
  await db.batch([guard(), sealArchiveDecode(db, snapshot.id, progress, decodedHash.digest("hex"))]);
  const sealed = await archiveDecode(db, snapshot.id).first<ArchiveDecode>();
  if (sealed?.state !== "decoded") throw new Error("Archive decode seal is missing.");
  return sealed;
}

async function* verifiedArchiveBytes(bucket: R2Bucket, snapshot: SnapshotRow) {
  const object = await bucket.get(snapshot.content_object_key);
  if (!object || object.size !== snapshot.content_byte_length)
    throw new Error("Source archive is missing or truncated.");
  const reader = object.body.getReader(),
    hash = createHash("sha256");
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > snapshot.content_byte_length) throw new Error("Source archive length changed.");
      hash.update(next.value);
      // Keep decompressor input chunks independently bounded.
      for (let offset = 0; offset < next.value.byteLength; offset += 65536)
        yield next.value.subarray(offset, offset + 65536);
    }
    if (length !== snapshot.content_byte_length || hash.digest("hex") !== snapshot.content_digest)
      throw new Error("Source archive failed exact-byte verification.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
