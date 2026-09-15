import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import { type CatalogueStore, canonicalJson, sha256, sha256Text, utf8 } from "../shared";
import {
  archiveBlock,
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

const recordsPerCallback = 128;

/** Normalize a bounded raw-record window; each finish commits with its cursor. */
export async function parseArchiveBatch(
  db: CatalogueStore,
  bucket: R2Bucket,
  set: string,
  header: Record<string, unknown>,
  decoded: ArchiveDecode,
  extraction: NonNullable<SourceAdapterRegistration["archiveExtraction"]>,
  cutoff: string,
  guard: () => D1PreparedStatement,
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
  for (let processed = 0; progress.state === "normalizing" && progress.next_record < decoded.next_record;) {
    if (processed === recordsPerCallback) return null;
    if (!loaded || loaded.block.ordinal !== progress.next_block) {
      const block = await archiveBlock(db, decoded.source_snapshot_id, progress.next_block).first<ArchiveBlock>();
      if (!block || block.state !== "retained" || block.byte_length > 4 * 1024 * 1024)
        throw new Error("Decoded block is unavailable.");
      const object = await bucket.get(block.object_key);
      if (!object || object.size !== block.byte_length) throw new Error("Decoded block is missing or truncated.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== block.byte_length || (await sha256(bytes)) !== block.sha256)
        throw new Error("Decoded block digest changed.");
      loaded = { block, bytes };
    }
    const newline = loaded.bytes.indexOf(10, progress.block_offset);
    const end = newline < 0 ? loaded.bytes.byteLength : newline + 1;
    const bytes = loaded.bytes.subarray(progress.block_offset, end);
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
      ordinal: progress.next_record,
      source_key: parsed.sourceKey,
      block_ordinal: progress.next_block,
      block_offset: progress.block_offset,
      byte_length: bytes.byteLength,
      sha256: await sha256(bytes),
      exclusion: parsed.exclusion,
    };
    const next: ArchiveParseProgress = { ...progress };
    const statements: D1PreparedStatement[] = [guard(), insertArchiveRecordReceipt(db, set, receipt)];
    let digest = records.digest;
    if (parsed.exclusion === null) {
      const observation = parsed.observations[progress.next_variant];
      if (!observation) throw new Error("Archive finish cursor changed.");
      const partitioned = await retainSourceRecordText(
        db,
        set,
        {
          id: `srcobs_${set.slice(10)}_${records.next_ordinal + 1}`,
          ordinal: records.next_ordinal + 1,
          value: observation.value,
        },
        guard,
      );
      const content = canonicalJson({
        ...(partitioned.value as Record<string, unknown>),
        ...(partitioned.text_parts.length ? { source_text_parts: partitioned.text_parts } : {}),
      });
      const requests = progress.next_variant === 0 && parsed.requests.length ? parsed.requests : null;
      const row: SourceRecordRow = {
        ordinal: records.next_ordinal,
        source_key: observation.sourceKey,
        content,
        sha256: await sha256Text(content),
        request_json: canonicalJson(requests),
      };
      if (utf8(content).byteLength > 512000 || utf8(row.request_json).byteLength > 4096)
        throw new AdapterParseFailure("Archive observation exceeds its independent record/request byte limit.");
      digest = await sourceRecordNextDigest(records.digest, row);
      statements.push(
        insertSourceRecord(db, set, row),
        advanceSourceRecords(db, set, records.next_ordinal, records.next_ordinal + 1, digest),
      );
      next.observation_count++;
      next.next_variant++;
    }
    if (parsed.exclusion !== null || next.next_variant === parsed.observations.length) {
      next.next_record++;
      next.next_variant = 0;
      next.block_offset = end;
      if (end === loaded.bytes.byteLength) {
        next.next_block++;
        next.block_offset = 0;
      }
      if (parsed.exclusion === null) next.selected_records++;
      else {
        const exclusions = JSON.parse(next.excluded_counts_json) as Record<string, number>;
        exclusions[parsed.exclusion] = (exclusions[parsed.exclusion] ?? 0) + 1;
        next.excluded_counts_json = canonicalJson(exclusions);
      }
      processed++;
    }
    statements.push(advanceArchiveParse(db, progress, next));
    try {
      await db.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "source_archive_record_receipts.observation_set_id, source_archive_record_receipts.source_key",
        )
      )
        throw new AdapterParseFailure("Scryfall archive repeats a source record identifier.", { cause: error });
      throw error;
    }
    const retained = await archiveRecordReceipt(db, set, receipt.ordinal).first<ArchiveRecordReceipt>();
    if (canonicalJson(retained) !== canonicalJson(receipt)) throw new Error("Archive record replay changed.");
    progress = await archiveParseProgress(db, set).first<ArchiveParseProgress>();
    records = await sourceRecordProgress(db, set).first<SourceRecordProgress>();
    if (
      !progress ||
      !records ||
      canonicalJson(progress) !== canonicalJson(next) ||
      records.next_ordinal !== progress.observation_count ||
      records.digest !== digest
    )
      throw new Error("Archive parse progress changed.");
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
