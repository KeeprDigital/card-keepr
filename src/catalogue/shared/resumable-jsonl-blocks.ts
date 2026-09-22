import { SourceArchiveFailure, type SourceArchiveLimits } from "./gzip-jsonl";

/**
 * Exact JSONL records grouped into the same derived blocks as `gzipJsonlBlocks`
 * (a block closes before the record that would exceed its byte or record
 * bound), with a cursor that serializes between pushes. Pending bytes are the
 * open block's complete records followed by one partial record.
 */
export type JsonlBlockCursor = Readonly<{
  ordinal: number;
  offset: number;
  first_record: number;
  records: number;
  block_records: number;
  block_length: number;
  partial_length: number;
}>;

export type JsonlBlock = Readonly<{
  ordinal: number;
  offset: number;
  firstRecord: number;
  recordCount: number;
  bytes: Uint8Array;
}>;

function cursorNumber(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("Invalid archive block continuation state.");
  return value;
}

export class JsonlBlockAssembler {
  readonly #limits: SourceArchiveLimits;
  readonly #blockBytes: number;
  readonly #blockRecords: number;
  readonly #pending: Uint8Array;
  #ordinal = 0;
  #offset = 0;
  #firstRecord = 0;
  #records = 0;
  #blockRecordCount = 0;
  #blockLength = 0;
  #partialLength = 0;

  constructor(
    limits: SourceArchiveLimits,
    blockBytes: number,
    blockRecords: number,
    cursor?: JsonlBlockCursor,
    pending?: Uint8Array,
  ) {
    if (
      !Number.isSafeInteger(blockBytes) ||
      blockBytes < limits.recordBytes ||
      !Number.isSafeInteger(blockRecords) ||
      blockRecords < 1
    )
      throw new SourceArchiveFailure("Archive block limits must admit one bounded record.");
    this.#limits = limits;
    this.#blockBytes = blockBytes;
    this.#blockRecords = blockRecords;
    this.#pending = new Uint8Array(blockBytes + limits.recordBytes);
    if (!cursor) return;
    this.#ordinal = cursorNumber(cursor.ordinal, Number.MAX_SAFE_INTEGER);
    this.#offset = cursorNumber(cursor.offset, limits.decompressedBytes);
    this.#firstRecord = cursorNumber(cursor.first_record, limits.records);
    this.#records = cursorNumber(cursor.records, limits.records);
    this.#blockRecordCount = cursorNumber(cursor.block_records, blockRecords);
    this.#blockLength = cursorNumber(cursor.block_length, blockBytes);
    this.#partialLength = cursorNumber(cursor.partial_length, limits.recordBytes);
    if (
      !pending ||
      pending.byteLength !== this.#blockLength + this.#partialLength ||
      this.#records !== this.#firstRecord + this.#blockRecordCount ||
      (this.#blockRecordCount === 0) !== (this.#blockLength === 0)
    )
      throw new Error("Invalid archive block continuation state.");
    this.#pending.set(pending);
  }

  cursor(): { cursor: JsonlBlockCursor; pending: Uint8Array } {
    return {
      cursor: {
        ordinal: this.#ordinal,
        offset: this.#offset,
        first_record: this.#firstRecord,
        records: this.#records,
        block_records: this.#blockRecordCount,
        block_length: this.#blockLength,
        partial_length: this.#partialLength,
      },
      pending: this.#pending.slice(0, this.#blockLength + this.#partialLength),
    };
  }

  /** Consume decoded bytes until `maximumBlocks` close; returns closed blocks and bytes consumed. */
  push(bytes: Uint8Array, maximumBlocks: number): { blocks: JsonlBlock[]; consumed: number } {
    const blocks: JsonlBlock[] = [];
    let start = 0;
    while (start < bytes.byteLength && blocks.length < maximumBlocks) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.byteLength : newline + 1;
      const part = bytes.subarray(start, end);
      if (this.#partialLength + part.byteLength > this.#limits.recordBytes)
        throw new SourceArchiveFailure("Archive record exceeds its byte limit.");
      this.#pending.set(part, this.#blockLength + this.#partialLength);
      this.#partialLength += part.byteLength;
      start = end;
      if (newline >= 0) {
        const block = this.#completeRecord();
        if (block) blocks.push(block);
      }
    }
    return { blocks, consumed: start };
  }

  /** Close the final (possibly newline-free) record and block at verified EOF. */
  finish(): JsonlBlock[] {
    const blocks: JsonlBlock[] = [];
    if (this.#partialLength) {
      const block = this.#completeRecord();
      if (block) blocks.push(block);
    }
    if (this.#blockRecordCount) blocks.push(this.#close());
    return blocks;
  }

  #completeRecord(): JsonlBlock | null {
    if (this.#records >= this.#limits.records) throw new SourceArchiveFailure("Archive exceeds its record limit.");
    let closed: JsonlBlock | null = null;
    const length = this.#partialLength;
    if (
      this.#blockRecordCount &&
      (this.#blockLength + length > this.#blockBytes || this.#blockRecordCount === this.#blockRecords)
    ) {
      closed = this.#close();
      this.#pending.copyWithin(0, closed.bytes.byteLength, closed.bytes.byteLength + length);
    }
    this.#blockLength += length;
    this.#partialLength = 0;
    this.#blockRecordCount++;
    this.#records++;
    return closed;
  }

  #close(): JsonlBlock {
    const block = {
      ordinal: this.#ordinal++,
      offset: this.#offset,
      firstRecord: this.#firstRecord,
      recordCount: this.#blockRecordCount,
      bytes: this.#pending.slice(0, this.#blockLength),
    };
    this.#offset += this.#blockLength;
    this.#firstRecord += this.#blockRecordCount;
    this.#blockLength = 0;
    this.#blockRecordCount = 0;
    return block;
  }
}
