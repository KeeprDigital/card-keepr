import {
  sourceRecordInitialDigest,
  sourceRecordNextDigest,
  sealedSourceRecordProgress,
  sourceRecordPage,
  type SourceRecordRow,
} from "../source-evidence";
import {
  type CatalogueStore,
  type ObjectMemberCursor,
  type StreamingSha256State,
  canonicalJson,
  sha256Text,
  StreamingSha256,
  resumableObjectMembers,
} from "../shared";
import { documentStorage } from "./reconciliation-document";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { retainSourceObservations, readSourceObservation } from "./reconciliation-source-observation";
import {
  sourceByteChunkStatement,
  retainSourceByteChunkStatement,
  sourceDocumentHeaderStatement,
  retainSourceDocumentHeaderStatement,
} from "./reconciliation-source-document-repository";

type SourceRow = {
  observation_set_id: string;
  content_object_key: string;
  content_byte_length: number;
  content_digest: string;
};
type Cursor = {
  inputDigest: string;
  sequenceNumber: number;
  requestId: string;
  complete: boolean;
  offset: number;
  chunks: number;
  carry: number[];
  hash: StreamingSha256State;
  stage: "bytes" | "records";
  member: ObjectMemberCursor | null;
  values: Record<string, unknown>;
  observations: number;
  recordDigest?: string;
};
type Stored = { content: string; sha256: string };
type Header = { provenance: string; values: Record<string, unknown>; observationCount: number };

/** Hash exact ranged bytes before parsing addressable, independently verified chunks. */
export async function prepareSourceDocuments<T extends SourceRow>(
  database: CatalogueStore,
  objects: R2Bucket,
  runId: string,
  inputDigest: string,
  evidenceAfter: (after?: { sequenceNumber: number; requestId: string; complete?: boolean }) => AsyncIterable<{
    request: { sequence_number: number; request_id: string };
    row: T | null;
  }>,
  validate: (row: T, values: Record<string, unknown>, observations: number) => void,
  yieldAtCheckpoint: boolean,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "source_documents");
  if (checkpoint && checkpoint.value.inputDigest !== inputDigest) throw new Error("Source document selection changed.");
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  const saveCursor = async (cursor: Cursor) => {
    await retainReconciliationCheckpoint(database, runId, "source_documents", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "source_documents", ordinal });
    ordinal++;
  };
  let skipped: Cursor | null = null;
  let skippedCount = 0;
  for await (const { request, row } of evidenceAfter(checkpoint?.value)) {
    // Preserve progress through unavailable selections before spending a document's
    // own callback budget. Their verified selection still participates in ordering.
    if (row !== null && skipped !== null) {
      await saveCursor(skipped);
      skipped = null;
      skippedCount = 0;
    }
    const cursor: Cursor =
      checkpoint?.value.requestId === request.request_id && !checkpoint.value.complete
        ? checkpoint.value
        : {
            inputDigest,
            sequenceNumber: request.sequence_number,
            requestId: request.request_id,
            complete: false,
            offset: 0,
            chunks: 0,
            carry: [],
            hash: new StreamingSha256().checkpoint,
            stage: "bytes",
            member: null,
            values: {},
            observations: 0,
          };
    const save = () => saveCursor(cursor);
    if (row === null) {
      cursor.complete = true;
      skipped = cursor;
      if (++skippedCount === 16) {
        await save();
        skipped = null;
        skippedCount = 0;
      }
      continue;
    }
    const bounded = await sealedSourceRecordProgress(database, row.observation_set_id, documentStorage);
    if (bounded) {
      if (cursor.recordDigest === undefined) {
        if (row.content_byte_length > 32768) throw new Error("Source record manifest exceeds 32 KiB.");
        const object = await documentStorage(() => objects.get(row.content_object_key));
        if (!object || object.size !== row.content_byte_length)
          throw new Error("Source record manifest is unavailable.");
        const content = await documentStorage(() => object.text());
        if ((await sha256Text(content)) !== row.content_digest)
          throw new Error("Source record manifest digest changed.");
        const manifest = JSON.parse(content) as Record<string, unknown>;
        const storage = manifest.record_storage as { contract?: string; count?: number; sha256?: string } | undefined;
        if (
          storage?.contract !== "card-keepr-source-records@1" ||
          storage.count !== bounded.next_ordinal ||
          storage.sha256 !== bounded.digest
        )
          throw new Error("Source record manifest is not sealed to its persisted records.");
        cursor.values = { ...manifest, observations: true };
        cursor.recordDigest = await sourceRecordInitialDigest(row.observation_set_id, bounded.header_json);
      }
      while (cursor.observations < bounded.next_ordinal) {
        const records = (
          await documentStorage(() =>
            sourceRecordPage(database, row.observation_set_id, cursor.observations - 1).all<SourceRecordRow>(),
          )
        ).results;
        if (!records.length) throw new Error("Source record manifest has missing records.");
        for (const record of records) {
          if (record.ordinal !== cursor.observations || (await sha256Text(record.content)) !== record.sha256)
            throw new Error("Source record manifest failed integrity verification.");
          cursor.recordDigest = await sourceRecordNextDigest(cursor.recordDigest, record);
          cursor.observations++;
        }
        await save();
      }
      if (cursor.recordDigest !== bounded.digest) throw new Error("Source record root digest changed.");
    } else {
      if (cursor.stage === "bytes") {
        const hash = new StreamingSha256(cursor.hash);
        let chunksInUnit = 0;
        let retainedBytes = 0;
        while (cursor.offset < row.content_byte_length) {
          const length = Math.min(65536, row.content_byte_length - cursor.offset);
          const object = await documentStorage(() =>
            objects.get(row.content_object_key, { range: { offset: cursor.offset, length } }),
          );
          if (!object || object.size !== row.content_byte_length)
            throw new Error("Retained Source Observation Set bytes are unavailable.");
          const bytes = new Uint8Array(await documentStorage(() => object.arrayBuffer()));
          if (bytes.byteLength !== length) throw new Error("Retained source byte range is incomplete.");
          const joined = new Uint8Array(cursor.carry.length + bytes.byteLength);
          joined.set(cursor.carry);
          joined.set(bytes, cursor.carry.length);
          const end = completeUtf8Prefix(joined);
          const content = canonicalJson([
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: cursor.offset > 0 }).decode(joined.subarray(0, end)),
          ]);
          const digest = await sha256Text(content);
          await documentStorage(() =>
            retainSourceByteChunkStatement(
              database,
              runId,
              row.observation_set_id,
              cursor.chunks,
              content,
              digest,
            ).run(),
          );
          await verifyStored(
            () => sourceByteChunkStatement(database, runId, row.observation_set_id, cursor.chunks),
            content,
            digest,
          );
          hash.update(bytes);
          cursor.offset += bytes.byteLength;
          cursor.chunks++;
          cursor.carry = [...joined.subarray(end)];
          cursor.hash = hash.checkpoint;
          if (cursor.offset === row.content_byte_length) {
            if (cursor.carry.length || hash.digestHex() !== row.content_digest)
              throw new Error("Retained Source Observation Set digest or UTF-8 is invalid.");
            cursor.stage = "records";
          }
          chunksInUnit++;
          retainedBytes += new TextEncoder().encode(content).byteLength;
          if (chunksInUnit === 4 || retainedBytes >= 512000 || cursor.stage === "records") {
            await save();
            chunksInUnit = 0;
            retainedBytes = 0;
          }
        }
        if (cursor.stage === "bytes") throw new Error("Retained Source Observation Set is empty.");
      }
      let records = 0;
      let bytes = 0;
      let previous = cursor.member;
      for await (const { member, cursor: next } of resumableObjectMembers(
        (chunk) => sourceChunks(database, runId, row.observation_set_id, cursor.chunks, chunk),
        cursor.member,
        {
          maximumTokenCharacters: 4194304,
          maximumTokenBytes: 4194304,
          maximumStructuralTokens: 16384,
          maximumDepth: 128,
        },
      )) {
        const size = member.kind === "value" ? new TextEncoder().encode(canonicalJson(member.value)).byteLength : 0;
        if (records > 0 && bytes + size > 512000) {
          cursor.member = previous;
          await save();
          records = 0;
          bytes = 0;
        }
        if (member.key === "observations") {
          if (member.kind === "array") cursor.values.observations = true;
          else if (member.array) {
            await retainSourceObservations(
              database,
              runId,
              row.observation_set_id,
              [member.value],
              cursor.observations,
            );
            cursor.observations++;
          } else throw new Error("Retained observations must be an array.");
        } else {
          if (member.kind === "array" || member.array)
            throw new Error("Retained source document has an unexpected array member.");
          Object.defineProperty(cursor.values, member.key, {
            value: member.value,
            writable: true,
            enumerable: true,
            configurable: true,
          });
          if (new TextEncoder().encode(canonicalJson(cursor.values)).byteLength > 32768)
            throw new Error("reconciliation_capacity_exceeded: one source document header exceeds 32 KiB.");
        }
        cursor.member = next;
        previous = next;
        bytes += size;
        if (++records === 32 || bytes >= 512000) {
          await save();
          records = 0;
          bytes = 0;
        }
      }
    }
    validate(row, cursor.values, cursor.observations);
    const content = canonicalJson({
      provenance: await sha256Text(canonicalJson(row)),
      values: cursor.values,
      observationCount: cursor.observations,
    } satisfies Header);
    const digest = await sha256Text(content);
    await documentStorage(() =>
      retainSourceDocumentHeaderStatement(database, runId, row.observation_set_id, content, digest).run(),
    );
    await verifyStored(() => sourceDocumentHeaderStatement(database, runId, row.observation_set_id), content, digest);
    cursor.complete = true;
    await save();
  }
  if (skipped !== null) await saveCursor(skipped);
}

async function verifyStored(
  statement: () => ReturnType<typeof sourceByteChunkStatement>,
  content: string,
  digest: string,
) {
  const receipt = await documentStorage(() => statement().first<Stored>());
  if (receipt?.content !== content || receipt.sha256 !== digest)
    throw new Error("Source document replay changed immutable content.");
}
async function* sourceChunks(database: CatalogueStore, run: string, set: string, count: number, start: number) {
  for (let ordinal = start; ordinal < count; ) {
    const end = Math.min(ordinal + 4, count);
    const rows = await documentStorage(() =>
      database.batch<Stored>(
        Array.from({ length: end - ordinal }, (_, offset) =>
          sourceByteChunkStatement(database, run, set, ordinal + offset),
        ),
      ),
    );
    for (const result of rows) {
      const row = result.results[0];
      if (!row || (await sha256Text(row.content)) !== row.sha256)
        throw new Error("Retained source byte chunk failed integrity verification.");
      yield (JSON.parse(row.content) as string[])[0]!;
    }
    ordinal = end;
  }
}
export async function readSourceDocument<T extends SourceRow>(database: CatalogueStore, runId: string, row: T) {
  const retained = await documentStorage(() =>
    sourceDocumentHeaderStatement(database, runId, row.observation_set_id).first<Stored>(),
  );
  if (!retained || (await sha256Text(retained.content)) !== retained.sha256)
    throw new Error("Source document header failed integrity verification.");
  const header = JSON.parse(retained.content) as Header;
  if (header.provenance !== (await sha256Text(canonicalJson(row))))
    throw new Error("Source document provenance changed.");
  return {
    ...header,
    observations: {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < header.observationCount; index++)
          yield await readSourceObservation(database, runId, row.observation_set_id, index);
      },
    },
  };
}
function completeUtf8Prefix(bytes: Uint8Array): number {
  let start = bytes.length - 1;
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) throw new Error("Invalid UTF-8 source continuation.");
  const first = bytes[start]!;
  const width =
    first < 0x80
      ? 1
      : first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 1;
  return bytes.length - start < width ? start : bytes.length;
}
