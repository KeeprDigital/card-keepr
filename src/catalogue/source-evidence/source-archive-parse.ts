import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import { type CatalogueStore, canonicalJson, sha256, sha256Text, utf8 } from "../shared";
import {
  archiveBlock,
  archiveParseCursorGuard,
  archiveParseProgress,
  initializeArchiveParse,
  advanceArchiveParse,
  insertArchiveRecordReceipt,
  archiveRecordReceipt,
  type ArchiveBlock,
  type ArchiveDecode,
  type ArchiveParseProgress,
  type ArchiveRecordReceipt,
} from "./source-archive-repository";
import {
  advanceSourceRecords,
  initializeSourceRecords,
  insertSourceRecord,
  sourceRecordProgress,
  type SourceRecordProgress,
  type SourceRecordRow,
} from "./source-record-repository";
import { sourceRecordInitialDigest, sourceRecordNextDigest } from "./source-record-intake";
import { retainSourceRecordText } from "./source-record-text";
import { retainSourceRecordRequests } from "./source-record-requests";

/**
 * Declared per-call (one Workflow step) normalization budget. A call admits at
 * most `records` raw records or `sourceBytes` of their bytes, committed in
 * atomic transactions of at most `transactionRecords` records or
 * `transactionBytes` of retained observation content. Each transaction carries
 * both cursors as a precondition, so a replay or lost response can neither
 * skip nor duplicate a record.
 */
export const archiveNormalizationStepBudget = Object.freeze({
  records: 1024,
  sourceBytes: 8 * 1024 * 1024,
  transactionRecords: 64,
  transactionBytes: 1024 * 1024,
});
export type ArchiveNormalizationBudget = Readonly<{
  records: number;
  sourceBytes: number;
  transactionRecords: number;
  transactionBytes: number;
}>;

/** Normalize a bounded raw-record window; each transaction commits with its cursor. */
export async function parseArchiveBatch(
  db: CatalogueStore,
  bucket: R2Bucket,
  set: string,
  header: Record<string, unknown>,
  decoded: ArchiveDecode,
  extraction: NonNullable<SourceAdapterRegistration["archiveExtraction"]>,
  cutoff: string,
  guard: () => D1PreparedStatement,
  budget: ArchiveNormalizationBudget = archiveNormalizationStepBudget,
): Promise<Record<string, unknown> | null> {
  if (decoded.state !== "decoded" || decoded.decoded_digest === null) throw new Error("Source archive is not sealed.");
  const archiveHeader = {
    ...header,
    source_archive: {
      contract: "card-keepr-source-archive@1",
      source_snapshot_id: decoded.source_snapshot_id,
      block_count: decoded.next_block,
      raw_record_count: decoded.next_record,
      decoded_bytes: decoded.decoded_bytes,
      decoded_sha256: decoded.decoded_digest,
      blocks_sha256: decoded.digest,
    },
  };
  const headerJson = canonicalJson({ ...archiveHeader, pagination: null, requests: [], request_storage: true });
  const initial = await sourceRecordInitialDigest(set, headerJson);
  await db.batch([guard(), initializeSourceRecords(db, set, initial, headerJson), initializeArchiveParse(db, set)]);
  let progress = await archiveParseProgress(db, set).first<ArchiveParseProgress>();
  let records = await sourceRecordProgress(db, set).first<SourceRecordProgress>();
  if (
    !progress ||
    !records ||
    records.header_json !== headerJson ||
    records.next_ordinal !== progress.observation_count
  )
    throw new Error("Archive parse cursor changed immutable input.");
  let loaded: { block: ArchiveBlock; bytes: Uint8Array } | null = null;
  const blockBytes = async (ordinal: number) => {
    if (loaded?.block.ordinal === ordinal) return loaded.bytes;
    const block = await archiveBlock(db, decoded.source_snapshot_id, ordinal).first<ArchiveBlock>();
    if (!block || block.state !== "retained" || block.byte_length > 4 * 1024 * 1024)
      throw new Error("Decoded block is unavailable.");
    const object = await bucket.get(block.object_key);
    if (!object || object.size !== block.byte_length) throw new Error("Decoded block is missing or truncated.");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== block.byte_length || (await sha256(bytes)) !== block.sha256)
      throw new Error("Decoded block digest changed.");
    loaded = { block, bytes };
    return bytes;
  };
  let admittedRecords = 0,
    admittedBytes = 0;
  while (progress.state === "normalizing" && progress.next_record < decoded.next_record) {
    if (admittedRecords >= budget.records || admittedBytes >= budget.sourceBytes) return null;
    const prior: ArchiveParseProgress = progress;
    const next: ArchiveParseProgress = { ...prior };
    const statements: D1PreparedStatement[] = [guard(), archiveParseCursorGuard(db, prior, records)];
    const receipts: { index: number; receipt: ArchiveRecordReceipt }[] = [];
    let ordinal: number = records.next_ordinal,
      digest: string = records.digest,
      transactionRecords = 0,
      transactionBytes = 0;
    while (
      next.next_record < decoded.next_record &&
      transactionRecords < budget.transactionRecords &&
      transactionBytes < budget.transactionBytes &&
      admittedRecords < budget.records &&
      admittedBytes < budget.sourceBytes
    ) {
      const block = await blockBytes(next.next_block);
      const newline = block.indexOf(10, next.block_offset);
      const end = newline < 0 ? block.byteLength : newline + 1;
      const bytes = block.subarray(next.block_offset, end);
      if (!bytes.byteLength || bytes.byteLength > 128 * 1024)
        throw new AdapterParseFailure("Archive record boundary is invalid.");
      const parsed = extraction.record(bytes, cutoff);
      if (
        parsed.observations.length > 3 ||
        parsed.requests.length > 16 ||
        (parsed.exclusion === null ? parsed.observations.length === 0 : parsed.observations.length !== 0)
      )
        throw new AdapterParseFailure("Archive record classification exceeds its declared contract.");
      const receipt: ArchiveRecordReceipt = {
        ordinal: next.next_record,
        source_key: parsed.sourceKey,
        block_ordinal: next.next_block,
        block_offset: next.block_offset,
        byte_length: bytes.byteLength,
        sha256: await sha256(bytes),
        exclusion: parsed.exclusion,
      };
      // A record resumed mid-way (legacy per-variant progress) already holds its receipt.
      if (next.next_variant === 0) {
        receipts.push({ index: statements.length, receipt });
        statements.push(insertArchiveRecordReceipt(db, set, receipt));
      }
      if (parsed.exclusion === null) {
        if (next.next_variant >= parsed.observations.length) throw new Error("Archive finish cursor changed.");
        for (let variant = next.next_variant; variant < parsed.observations.length; variant++) {
          const observation = parsed.observations[variant]!;
          const partitioned = await retainSourceRecordText(
            db,
            set,
            { id: `srcobs_${set.slice(10)}_${ordinal + 1}`, ordinal: ordinal + 1, value: observation.value },
            guard,
          );
          const content = canonicalJson({
            ...(partitioned.value as Record<string, unknown>),
            ...(partitioned.text_parts.length ? { source_text_parts: partitioned.text_parts } : {}),
          });
          const requests = variant === 0 && parsed.requests.length ? parsed.requests : null;
          const row: SourceRecordRow = {
            ordinal,
            source_key: observation.sourceKey,
            content,
            sha256: await sha256Text(content),
            request_json: canonicalJson(requests),
          };
          const contentBytes = utf8(content).byteLength;
          if (contentBytes > 512000 || utf8(row.request_json).byteLength > 4096)
            throw new AdapterParseFailure("Archive observation exceeds its independent record/request byte limit.");
          digest = await sourceRecordNextDigest(digest, row);
          statements.push(insertSourceRecord(db, set, row));
          ordinal++;
          next.observation_count++;
          transactionBytes += contentBytes;
        }
        next.selected_records++;
      } else {
        const exclusions = JSON.parse(next.excluded_counts_json) as Record<string, number>;
        exclusions[parsed.exclusion] = (exclusions[parsed.exclusion] ?? 0) + 1;
        next.excluded_counts_json = canonicalJson(exclusions);
      }
      next.next_record++;
      next.next_variant = 0;
      next.block_offset = end;
      if (end === block.byteLength) {
        next.next_block++;
        next.block_offset = 0;
      }
      transactionRecords++;
      admittedRecords++;
      admittedBytes += bytes.byteLength;
    }
    const recordsAdvance = statements.length;
    statements.push(advanceSourceRecords(db, set, records.next_ordinal, ordinal, digest));
    statements.push(advanceArchiveParse(db, prior, next));
    let results: D1Result[];
    try {
      results = await db.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "source_archive_record_receipts.observation_set_id, source_archive_record_receipts.source_key",
        )
      )
        throw new AdapterParseFailure("Scryfall archive repeats a source record identifier.", { cause: error });
      if (error instanceof Error && error.message.includes("archive_parse_cursor_changed"))
        throw new Error("Archive parse progress changed.", { cause: error });
      throw error;
    }
    if (results[recordsAdvance]?.meta.changes !== 1 || results[recordsAdvance + 1]?.meta.changes !== 1)
      throw new Error("Archive parse progress changed.");
    // Receipts are append-only; a pre-existing row must be the identical receipt.
    for (const { index, receipt } of receipts) {
      if (results[index]?.meta.changes === 1) continue;
      const retained = await archiveRecordReceipt(db, set, receipt.ordinal).first<ArchiveRecordReceipt>();
      if (canonicalJson(retained) !== canonicalJson(receipt)) throw new Error("Archive record replay changed.");
    }
    progress = next;
    records = { ...records, next_ordinal: ordinal, digest };
  }
  if (
    progress.next_record !== decoded.next_record ||
    progress.next_variant !== 0 ||
    progress.next_block !== decoded.next_block ||
    progress.block_offset !== 0
  )
    throw new Error("Archive records do not cover the sealed decoded source.");
  if (progress.state === "normalizing") {
    const next: ArchiveParseProgress = { ...progress, state: "normalized" };
    await db.batch([guard(), advanceArchiveParse(db, progress, next)]);
  }
  const requests = await retainSourceRecordRequests(db, set, [], guard);
  return {
    ...archiveHeader,
    source_archive_census: {
      raw_records: decoded.next_record,
      selected_records: progress.selected_records,
      observations: progress.observation_count,
      exclusions: JSON.parse(progress.excluded_counts_json),
    },
    evidence_summary: {
      observation_count: progress.observation_count,
      declared_record_count: progress.observation_count,
      parsed_record_count: progress.observation_count,
      required_surfaces_complete: true,
      partitions_complete: true,
      structurally_complete: true,
    },
    record_storage: {
      contract: "card-keepr-source-records@1",
      count: progress.observation_count,
      sha256: records.digest,
      requests,
    },
  };
}
