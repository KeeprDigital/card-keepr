import { createHash } from "node:crypto";
import { type CatalogueStore, canonicalJson, sha256Text, utf8 } from "../shared";
import { AdapterParseFailure, type SourceAdapterRegistration } from "../adapters";
import type { SnapshotRow } from "./source-evidence-repository-types";
import {
  advanceSourceRecords,
  initializeSourceRecords,
  insertSourceRecord,
  sourceRecordPage,
  sourceRecordProgress,
  type SourceRecordProgress,
  type SourceRecordRow,
} from "./source-record-repository";

type Extraction = Awaited<ReturnType<NonNullable<SourceAdapterRegistration["recordExtraction"]>["extract"]>>;

/** Two bounded scans verify the immutable raw object; no whole-body text/byte buffer. */
export async function* verifiedSnapshotChunks(bucket: R2Bucket, snapshot: SnapshotRow) {
  const object = await bucket.get(snapshot.content_object_key);
  if (!object || object.size !== snapshot.content_byte_length)
    throw new Error("Source Snapshot bytes are unavailable or truncated");
  const reader = object.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  const decode = (bytes?: Uint8Array, stream = false) => {
    try {
      return decoder.decode(bytes, { stream });
    } catch (error) {
      if (error instanceof TypeError)
        throw new AdapterParseFailure("The Source bytes are not valid UTF-8.", { cause: error });
      throw error;
    }
  };
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > snapshot.content_byte_length) throw new Error("Source Snapshot length changed");
      hash.update(next.value);
      for (let offset = 0; offset < next.value.length; offset += 65536)
        yield decode(next.value.subarray(offset, offset + 65536), true);
    }
    yield decode();
    if (bytes !== snapshot.content_byte_length || hash.digest("hex") !== snapshot.content_digest)
      throw new Error("Source Snapshot bytes failed digest verification");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function retainExtractedSourceRecords(
  db: CatalogueStore,
  id: string,
  header: Record<string, unknown>,
  extraction: Extraction,
) {
  const headerJson = canonicalJson({ ...header, pagination: extraction.pagination, requests: extraction.requests });
  if (utf8(headerJson).byteLength > 32768) throw new Error("Source record header exceeds 32 KiB");
  const initialDigest = await sourceRecordInitialDigest(id, headerJson);
  try {
    await initializeSourceRecords(db, id, initialDigest, headerJson).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("source_pagination_changed"))
      throw new AdapterParseFailure("Riftbound pagination identity changed within the collection.", { cause: error });
    throw error;
  }
  const progress = await sourceRecordProgress(db, id).first<SourceRecordProgress>();
  if (
    !progress ||
    progress.header_json !== headerJson ||
    progress.next_ordinal > extraction.count ||
    (progress.next_ordinal === 0 && progress.digest !== initialDigest)
  )
    throw new Error("Source record progress changed immutable input");
  let ordinal = 0,
    digest = initialDigest,
    pending: SourceRecordRow[] = [],
    pendingBytes = 0;
  const flush = async () => {
    if (!pending.length) return;
    const first = pending[0]!.ordinal;
    try {
      await db.batch([
        ...pending.map((row) => insertSourceRecord(db, id, row)),
        advanceSourceRecords(db, id, first, ordinal, digest),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: source_record_pages.observation_set_id, source_record_pages.source_key",
        )
      )
        throw new AdapterParseFailure("Riftbound page repeats a source record identifier.", { cause: error });
      throw error;
    }
    const retained = await sourceRecordPage(db, id, first - 1, pending.length).all<SourceRecordRow>();
    if (canonicalJson(retained.results) !== canonicalJson(pending))
      throw new Error("Immutable source record replay changed");
    pending = [];
    pendingBytes = 0;
  };
  const summary = {
    observation_count: extraction.count,
    declared_record_count: 0,
    parsed_record_count: 0,
    required_surfaces_complete: true,
    partitions_complete: true,
    structurally_complete: true,
  };
  for await (const record of extraction.records) {
    const value = record.value as { completeness?: Record<string, unknown> } | null;
    const completeness = value?.completeness;
    summary.declared_record_count += Number.isInteger(completeness?.declared_record_count)
      ? Number(completeness!.declared_record_count)
      : 0;
    summary.parsed_record_count += Number.isInteger(completeness?.parsed_record_count)
      ? Number(completeness!.parsed_record_count)
      : 0;
    summary.required_surfaces_complete &&= completeness?.required_surfaces_complete === true;
    summary.partitions_complete &&= completeness?.partitions_complete === true;
    summary.structurally_complete &&= completeness?.structurally_complete === true;
    if (ordinal >= extraction.count) throw new Error("Source record count changed");
    const content = canonicalJson({
      id: `srcobs_${id.slice(10)}_${ordinal + 1}`,
      ordinal: ordinal + 1,
      value: record.value,
    });
    const size = utf8(content).byteLength;
    if (size > 512000) throw new AdapterParseFailure("One extracted observation exceeds 512,000 bytes");
    if (pending.length && (pending.length === 8 || pendingBytes + size > 512000)) await flush();
    const row = {
      ordinal,
      source_key: record.sourceKey,
      content,
      sha256: await sha256Text(content),
      request_json: canonicalJson(record.request),
    };
    if (utf8(row.request_json).byteLength > 4096) throw new AdapterParseFailure("Source image request exceeds 4 KiB.");
    digest = await sourceRecordNextDigest(digest, row);
    ordinal++;
    if (ordinal === progress.next_ordinal && digest !== progress.digest)
      throw new Error("Source record prefix digest changed");
    if (row.ordinal < progress.next_ordinal) continue;
    pending.push(row);
    pendingBytes += size;
  }
  await flush();
  if (ordinal !== extraction.count) throw new Error("Source record count changed");
  const final = await sourceRecordProgress(db, id).first<SourceRecordProgress>();
  if (final?.next_ordinal !== ordinal || final.digest !== digest)
    throw new Error("Source record progress is incomplete");
  summary.structurally_complete &&= summary.declared_record_count === summary.parsed_record_count;
  return {
    ...header,
    evidence_summary: summary,
    record_storage: { contract: "card-keepr-source-records@1", count: ordinal, sha256: digest },
  };
}

/** A sealed manifest alone is not enough: consumers require the finalized SQL authority too. */
export async function sealedSourceRecordProgress(
  db: CatalogueStore,
  id: string,
  read: (operation: () => Promise<SourceRecordProgress | null>) => Promise<SourceRecordProgress | null> = (operation) =>
    operation(),
) {
  const progress = await read(() => sourceRecordProgress(db, id).first<SourceRecordProgress>());
  if (!progress) return null;
  if (progress.sealed !== 1 || progress.authoritative !== 1) throw new Error("Source records are not sealed.");
  return progress;
}

export async function* discoveredSourceRecordRequests(db: CatalogueStore, id: string) {
  const progress = await sealedSourceRecordProgress(db, id);
  if (!progress) throw new Error("Source record progress is missing.");
  const header = JSON.parse(progress.header_json) as { requests: Extraction["requests"] };
  yield header.requests;
  let ordinal = 0;
  let digest = await sourceRecordInitialDigest(id, progress.header_json);
  while (ordinal < progress.next_ordinal) {
    const rows = (await sourceRecordPage(db, id, ordinal - 1).all<SourceRecordRow>()).results;
    if (!rows.length) throw new Error("Source record request page is incomplete.");
    const requests: { role: "image"; url: string; headers: Record<string, string> }[] = [];
    for (const row of rows) {
      if (row.ordinal !== ordinal++ || (await sha256Text(row.content)) !== row.sha256)
        throw new Error("Source record request page failed integrity verification.");
      digest = await sourceRecordNextDigest(digest, row);
      requests.push(JSON.parse(row.request_json));
    }
    yield requests;
  }
  if (digest !== progress.digest) throw new Error("Source record request root digest changed.");
}

export function sourceRecordInitialDigest(id: string, header: string) {
  return sha256Text(canonicalJson({ contract: "card-keepr-source-records@1", id, header }));
}
export function sourceRecordNextDigest(previous: string, record: SourceRecordRow) {
  return sha256Text(
    canonicalJson({
      previous,
      ordinal: record.ordinal,
      sha256: record.sha256,
      source_key: record.source_key,
      request_json: record.request_json,
    }),
  );
}
