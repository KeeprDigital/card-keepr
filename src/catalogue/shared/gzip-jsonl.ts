export type SourceArchiveLimits = Readonly<{
  compressedBytes: number;
  decompressedBytes: number;
  recordBytes: number;
  records: number;
}>;

export class SourceArchiveFailure extends Error {}

/** Exact JSONL byte ranges; successful EOF also verifies the gzip trailer. */
export async function* gzipJsonlRecords(source: AsyncIterable<Uint8Array>, limits: SourceArchiveLimits) {
  if (Object.values(limits).some((limit) => !Number.isSafeInteger(limit) || limit < 1))
    throw new SourceArchiveFailure("Archive limits must be positive safe integers.");
  const iterator = source[Symbol.asyncIterator]();
  let compressed = 0;
  let upstreamFailure: { error: unknown } | undefined;
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else {
          compressed += next.value.byteLength;
          if (compressed > limits.compressedBytes)
            throw new SourceArchiveFailure("Compressed archive exceeds its byte limit.");
          controller.enqueue(next.value);
        }
      } catch (error) {
        upstreamFailure = { error };
        throw error;
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader();
  const pending = new Uint8Array(limits.recordBytes);
  let length = 0,
    decoded = 0,
    ordinal = 0,
    offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      decoded += next.value.byteLength;
      if (decoded > limits.decompressedBytes)
        throw new SourceArchiveFailure("Decompressed archive exceeds its byte limit.");
      let start = 0;
      while (start < next.value.length) {
        const newline = next.value.indexOf(10, start);
        const end = newline < 0 ? next.value.length : newline + 1;
        const part = next.value.subarray(start, end);
        if (length + part.byteLength > pending.byteLength)
          throw new SourceArchiveFailure("Archive record exceeds its byte limit.");
        pending.set(part, length);
        length += part.byteLength;
        start = end;
        if (newline < 0) continue;
        if (ordinal >= limits.records) throw new SourceArchiveFailure("Archive exceeds its record limit.");
        yield { ordinal: ordinal++, offset, bytes: pending.slice(0, length) };
        offset += length;
        length = 0;
      }
    }
    if (length) {
      if (ordinal >= limits.records) throw new SourceArchiveFailure("Archive exceeds its record limit.");
      yield { ordinal, offset, bytes: pending.slice(0, length) };
    }
  } catch (error) {
    // Native decompression can recreate upstream errors; preserve their original provenance.
    if (upstreamFailure) throw upstreamFailure.error;
    if (error instanceof TypeError)
      throw new SourceArchiveFailure("Gzip archive integrity verification failed.", { cause: error });
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await iterator.return?.();
  }
}

/** Derived blocks retain whole exact records; they do not become Source Snapshots. */
export async function* gzipJsonlBlocks(
  source: AsyncIterable<Uint8Array>,
  limits: SourceArchiveLimits,
  blockBytes = 4 * 1024 * 1024,
  blockRecords = 1024,
) {
  if (
    !Number.isSafeInteger(blockBytes) ||
    blockBytes < limits.recordBytes ||
    !Number.isSafeInteger(blockRecords) ||
    blockRecords < 1
  )
    throw new SourceArchiveFailure("Archive block limits must admit one bounded record.");
  const pending = new Uint8Array(blockBytes);
  let length = 0,
    count = 0,
    ordinal = 0,
    offset = 0,
    firstRecord = 0;
  for await (const record of gzipJsonlRecords(source, limits)) {
    if (count && (length + record.bytes.byteLength > blockBytes || count === blockRecords)) {
      yield { ordinal: ordinal++, offset, firstRecord, recordCount: count, bytes: pending.slice(0, length) };
      offset += length;
      firstRecord += count;
      length = 0;
      count = 0;
    }
    pending.set(record.bytes, length);
    length += record.bytes.byteLength;
    count++;
  }
  if (count) yield { ordinal, offset, firstRecord, recordCount: count, bytes: pending.slice(0, length) };
}
