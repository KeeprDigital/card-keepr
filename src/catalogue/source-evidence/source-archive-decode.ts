import {
  canonicalJson,
  JsonlBlockAssembler,
  ResumableGunzip,
  sha256,
  sha256Text,
  SourceArchiveFailure,
  type CatalogueStore,
  type GunzipCheckpoint,
  type JsonlBlock,
  type JsonlBlockCursor,
  type SourceArchiveLimits,
} from "../shared";
import {
  beginEvidenceObjectWrite,
  completeEvidenceObjectWrite,
  completeObservedEvidenceWrite,
} from "./evidence-cleanup-repository";
import { putImmutableEvidenceBytes } from "./source-evidence-object";
import {
  archiveBlock,
  archiveDecode,
  archiveDecodeCheckpoint,
  initializeArchiveDecode,
  planArchiveBlock,
  retainArchiveBlock,
  retainArchiveDecodeCheckpoint,
  advanceArchiveDecode,
  sealArchiveDecode,
  type ArchiveBlock,
  type ArchiveDecode,
  type ArchiveDecodeCheckpoint,
} from "./source-archive-repository";
import type { SnapshotRow } from "./source-evidence-repository-types";

/**
 * Declared per-call (one Workflow step) decode budget. A call verifies or
 * retains at most `blocks` derived blocks (plus the final block at EOF), each
 * at most 4 MiB / 1,024 records, so it inflates at most ~16 MiB and reads the
 * compressed archive in ranges of at most 1 MiB from its persisted cursor.
 */
export const archiveDecodeStepBudget = Object.freeze({ blocks: 4, blockBytes: 4 * 1024 * 1024 });
/**
 * Binding calls (D1, R2) one collection step may make while it advances an
 * archive by one bounded decode, normalization or discovery call, including
 * the step's own fence, progress and batch bookkeeping. Structure tests hold
 * every archive step to it; the invocation budget bounds their sum.
 */
export const archiveStepSubrequestCeiling = 200;
// The continuation keeps 32 KiB history, one open record and one decoded chunk.
const maximumContinuationBytes = 1024 * 1024;
const maximumResumableRecordBytes = 512 * 1024;
const continuationContract = "card-keepr-source-archive-decode@1";

type Continuation = {
  contract: typeof continuationContract;
  pin_sha256: string;
  digest: string;
  gunzip: GunzipCheckpoint;
  blocks: JsonlBlockCursor;
  window_length: number;
  pending_length: number;
  remainder_length: number;
};

/**
 * Decode the next bounded window of a retained gzip JSONL archive into derived
 * blocks. Progress resumes from the persisted gzip/JSONL continuation; blocks
 * below the committed cursor (a stale or absent continuation) are re-derived
 * and verified against their receipts, never written twice.
 */
export async function decodeArchiveBatch(
  db: CatalogueStore,
  bucket: R2Bucket,
  snapshot: SnapshotRow,
  pin: { cutoff: string; limits: SourceArchiveLimits },
  guard: () => D1PreparedStatement,
  blockRecords = 1024,
): Promise<ArchiveDecode> {
  if (!Number.isSafeInteger(blockRecords) || blockRecords < 1 || blockRecords > 1024)
    throw new Error("Archive block record capacity exceeds its independent bound.");
  if (pin.limits.recordBytes > maximumResumableRecordBytes)
    throw new SourceArchiveFailure("Archive record limit exceeds its resumable decode bound.");
  if (snapshot.content_byte_length > pin.limits.compressedBytes)
    throw new SourceArchiveFailure("Compressed archive exceeds its byte limit.");
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
  const pinDigest = await sha256Text(pinJson);
  const resumed = restoredContinuation(
    await archiveDecodeCheckpoint(db, snapshot.id).first<ArchiveDecodeCheckpoint>(),
    pinDigest,
    progress,
  );
  const gunzip = new ResumableGunzip(
    {
      length: snapshot.content_byte_length,
      sha256: snapshot.content_digest,
      decompressedBytes: pin.limits.decompressedBytes,
      read: retainedArchiveRange(bucket, snapshot),
    },
    resumed?.state.gunzip,
    resumed?.window,
  );
  const assembler = new JsonlBlockAssembler(
    pin.limits,
    archiveDecodeStepBudget.blockBytes,
    blockRecords,
    resumed?.state.blocks,
    resumed?.pending,
  );
  let remainder = resumed?.remainder ?? new Uint8Array(0);
  let digest = resumed?.state.digest ?? initial;
  let processed = 0;

  const handle = async (block: JsonlBlock) => {
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
    processed++;
    const current = progress!;
    if (block.ordinal < current.next_block) {
      const retained = await archiveBlock(db, snapshot.id, block.ordinal).first<ArchiveBlock>();
      if (canonicalJson(retained) !== canonicalJson(expected))
        throw new Error("Archive replay changed a retained block.");
      if (block.ordinal + 1 === current.next_block && digest !== current.digest)
        throw new Error("Archive prefix digest changed.");
      return;
    }
    if (block.ordinal !== current.next_block) throw new Error("Archive block cursor changed.");
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
      advanceArchiveDecode(db, snapshot.id, current, expected, digest),
    ]);
    progress = await archiveDecode(db, snapshot.id).first<ArchiveDecode>();
    if (!progress || progress.next_block !== block.ordinal + 1 || progress.digest !== digest)
      throw new Error("Archive decode progress changed.");
  };

  for (;;) {
    if (processed >= archiveDecodeStepBudget.blocks) {
      const { state, window } = gunzip.checkpoint();
      const { cursor, pending } = assembler.cursor();
      const bytes = new Uint8Array(window.byteLength + pending.byteLength + remainder.byteLength);
      bytes.set(window);
      bytes.set(pending, window.byteLength);
      bytes.set(remainder, window.byteLength + pending.byteLength);
      if (bytes.byteLength > maximumContinuationBytes)
        throw new Error("Archive decode continuation exceeds its bound.");
      const continuation: Continuation = {
        contract: continuationContract,
        pin_sha256: pinDigest,
        digest,
        gunzip: state,
        blocks: cursor,
        window_length: window.byteLength,
        pending_length: pending.byteLength,
        remainder_length: remainder.byteLength,
      };
      await db.batch([
        guard(),
        retainArchiveDecodeCheckpoint(db, snapshot.id, cursor.ordinal, canonicalJson(continuation), bytes),
      ]);
      return progress;
    }
    if (!remainder.byteLength) {
      const chunk = await gunzip.next();
      if (chunk === null) break;
      remainder = chunk;
    }
    const { blocks, consumed } = assembler.push(remainder, archiveDecodeStepBudget.blocks - processed);
    remainder = remainder.subarray(consumed);
    for (const block of blocks) await handle(block);
  }
  for (const block of assembler.finish()) await handle(block);
  // Only verified EOF (gzip trailer plus exact retained length and digest)
  // reaches this point. Prefix receipts alone never authorize normalization.
  if (
    assembler.cursor().cursor.ordinal !== progress.next_block ||
    digest !== progress.digest ||
    progress.next_record === 0 ||
    progress.decoded_bytes !== gunzip.decodedBytes
  )
    throw new Error("Archive completion is empty or inconsistent.");
  await db.batch([guard(), sealArchiveDecode(db, snapshot.id, progress, gunzip.decodedDigest)]);
  const sealed = await archiveDecode(db, snapshot.id).first<ArchiveDecode>();
  if (sealed?.state !== "decoded") throw new Error("Archive decode seal is missing.");
  return sealed;
}

function restoredContinuation(
  saved: ArchiveDecodeCheckpoint | null,
  pinDigest: string,
  progress: ArchiveDecode,
): { state: Continuation; window: Uint8Array; pending: Uint8Array; remainder: Uint8Array } | null {
  if (saved === null) return null;
  const state = JSON.parse(saved.checkpoint_json) as Continuation;
  // A continuation from another contract is ignored: re-deriving verifies the
  // retained prefix instead of trusting an unreadable cursor.
  if (state.contract !== continuationContract) return null;
  const bytes = new Uint8Array(saved.checkpoint_bytes);
  if (
    state.pin_sha256 !== pinDigest ||
    state.blocks.ordinal !== saved.checkpoint_block ||
    saved.checkpoint_block > progress.next_block ||
    (saved.checkpoint_block === progress.next_block && state.digest !== progress.digest) ||
    state.window_length + state.pending_length + state.remainder_length !== bytes.byteLength
  )
    throw new Error("Archive decode continuation is inconsistent.");
  const pendingEnd = state.window_length + state.pending_length;
  return {
    state,
    window: bytes.slice(0, state.window_length),
    pending: bytes.slice(state.window_length, pendingEnd),
    remainder: bytes.slice(pendingEnd),
  };
}

function retainedArchiveRange(bucket: R2Bucket, snapshot: SnapshotRow) {
  return async (offset: number, length: number) => {
    const object = await bucket.get(snapshot.content_object_key, { range: { offset, length } });
    if (!object || object.size !== snapshot.content_byte_length)
      throw new Error("Source archive is missing or truncated.");
    return { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag };
  };
}
