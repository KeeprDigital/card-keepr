import { SourceArchiveFailure } from "./gzip-jsonl";
import { StreamingSha256, type StreamingSha256State } from "./streaming-sha256";

/**
 * A gzip decoder whose complete state serializes between output chunks, so one
 * archive decodes across many bounded Workflow steps without replaying its
 * prefix. Native DecompressionStream state cannot be persisted, which made each
 * resumed step re-inflate everything before its cursor (#327).
 *
 * One call to `next()` reads at most a few compressed ranges and returns at
 * most `gunzipChunkBytes` (+ one 258-byte match) of output. Normal EOF alone
 * verifies the gzip CRC32/ISIZE trailer and the exact retained compressed
 * length and SHA-256; a prefix never authorizes completion.
 */

export const gunzipRangeBytes = 1024 * 1024;
export const gunzipChunkBytes = 64 * 1024;
const historyBytes = 32 * 1024;
const maximumMatch = 258;
// A dynamic block header needs at most ~570 bytes; one symbol at most 6.
const headerLookahead = 1024;
// Twice a symbol's 6 bytes, counted in bits because the cursor is a bit
// cursor: a whole-byte demand is short by the cursor's offset in its byte.
const symbolLookaheadBits = 12 * 8;
const maximumCompressedBytes = 255 * 1024 * 1024;

export type GunzipCheckpoint = Readonly<{
  contract: "card-keepr-gunzip-resume@1";
  bit: number;
  phase: "header" | "block" | "stored" | "codes" | "trailer" | "end";
  final: boolean;
  stored: number;
  lengths: number[] | null;
  literals: number;
  crc: number;
  decoded: number;
  raw_hashed: number;
  raw: StreamingSha256State;
  output: StreamingSha256State;
  etag: string | null;
}>;

export type GunzipSource = Readonly<{
  /** Exact retained compressed length and digest; EOF verifies both. */
  length: number;
  sha256: string;
  decompressedBytes: number;
  /** Return exactly `length` bytes starting at `offset` and the object's etag. */
  read: (offset: number, length: number) => Promise<{ bytes: Uint8Array; etag: string }>;
}>;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(crc: number, bytes: Uint8Array): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

const lengthBase = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const lengthExtra = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const distanceBase = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]);
const distanceExtra = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const codeLengthOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

type Table = { entries: Int32Array; bits: number };

function corrupt(): never {
  throw new SourceArchiveFailure("Gzip archive integrity verification failed.");
}

/** Canonical Huffman lookup: each entry is (symbol << 4) | code length; 0 is invalid. */
function huffmanTable(lengths: ArrayLike<number>, offset: number, count: number): Table {
  let bits = 0;
  const counts = new Uint16Array(16);
  for (let i = 0; i < count; i++) {
    const length = lengths[offset + i]!;
    counts[length]!++;
    if (length > bits) bits = length;
  }
  if (bits === 0) return { entries: new Int32Array(2), bits: 1 };
  counts[0] = 0;
  const next = new Uint16Array(16);
  let code = 0,
    left = 1;
  for (let length = 1; length <= 15; length++) {
    left = (left << 1) - counts[length]!;
    if (left < 0) corrupt();
    code = (code + counts[length - 1]!) << 1;
    next[length] = code;
  }
  const entries = new Int32Array(1 << bits);
  for (let symbol = 0; symbol < count; symbol++) {
    const length = lengths[offset + symbol]!;
    if (length === 0) continue;
    let value = next[length]!++;
    let reversed = 0;
    for (let i = 0; i < length; i++) {
      reversed = (reversed << 1) | (value & 1);
      value >>>= 1;
    }
    const entry = (symbol << 4) | length;
    for (let index = reversed; index < entries.length; index += 1 << length) entries[index] = entry;
  }
  return { entries, bits };
}

const fixedLengths = (() => {
  const lengths = new Uint8Array(320);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  lengths.fill(5, 288, 320);
  return lengths;
})();
let fixedTables: { literal: Table; distance: Table } | undefined;

function stateNumber(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("Invalid gunzip continuation state.");
  return value;
}

export class ResumableGunzip {
  readonly #source: GunzipSource;
  #buffer = new Uint8Array(0);
  #bufferStart = 0;
  #bit = 0;
  #phase: GunzipCheckpoint["phase"] = "header";
  #final = false;
  #stored = 0;
  #lengths: number[] | null = null;
  #literals = 0;
  #literal: Table | null = null;
  #distance: Table | null = null;
  #crc = 0;
  #decoded = 0;
  #rawHashed = 0;
  #raw: StreamingSha256;
  #output: StreamingSha256;
  #etag: string | null = null;
  // Output history is kept at [0, #history); new output is appended after it.
  readonly #out = new Uint8Array(historyBytes + gunzipChunkBytes + maximumMatch);
  #history = 0;
  #decodedDigest: string | null = null;

  constructor(source: GunzipSource, checkpoint?: GunzipCheckpoint, window?: Uint8Array) {
    if (!Number.isSafeInteger(source.length) || source.length < 1 || source.length > maximumCompressedBytes)
      throw new SourceArchiveFailure("Compressed archive exceeds its byte limit.");
    this.#source = source;
    if (!checkpoint) {
      this.#raw = new StreamingSha256();
      this.#output = new StreamingSha256();
      return;
    }
    if (checkpoint.contract !== "card-keepr-gunzip-resume@1" || !window)
      throw new Error("Invalid gunzip continuation state.");
    this.#bit = stateNumber(checkpoint.bit, source.length * 8);
    if (!["header", "block", "stored", "codes", "trailer"].includes(checkpoint.phase))
      throw new Error("Invalid gunzip continuation state.");
    this.#phase = checkpoint.phase;
    this.#final = checkpoint.final === true;
    this.#stored = stateNumber(checkpoint.stored, 65535);
    this.#literals = stateNumber(checkpoint.literals, 286);
    this.#crc = stateNumber(checkpoint.crc, 0xffffffff);
    this.#decoded = stateNumber(checkpoint.decoded, source.decompressedBytes);
    this.#rawHashed = stateNumber(checkpoint.raw_hashed, source.length);
    if (this.#rawHashed < this.#bit >>> 3) throw new Error("Invalid gunzip continuation state.");
    this.#etag = checkpoint.etag;
    this.#raw = new StreamingSha256(checkpoint.raw);
    this.#output = new StreamingSha256(checkpoint.output);
    if (
      BigInt(checkpoint.raw.bytes) !== BigInt(this.#rawHashed) ||
      BigInt(checkpoint.output.bytes) !== BigInt(this.#decoded)
    )
      throw new Error("Invalid gunzip continuation state.");
    if (window.byteLength !== Math.min(this.#decoded, historyBytes))
      throw new Error("Invalid gunzip continuation state.");
    this.#out.set(window);
    this.#history = window.byteLength;
    if (this.#phase === "codes") {
      if (checkpoint.lengths === null) this.#useFixed();
      else {
        if (
          !Array.isArray(checkpoint.lengths) ||
          checkpoint.lengths.length < this.#literals + 1 ||
          checkpoint.lengths.length > this.#literals + 30 ||
          checkpoint.lengths.some((length) => !Number.isInteger(length) || length < 0 || length > 15)
        )
          throw new Error("Invalid gunzip continuation state.");
        this.#useDynamic(checkpoint.lengths, this.#literals);
      }
    }
    this.#bufferStart = this.#bit >>> 3;
  }

  /** Serializable state; valid only between `next()` calls. */
  checkpoint(): { state: GunzipCheckpoint; window: Uint8Array } {
    if (this.#phase === "end") throw new Error("A completed gunzip stream cannot be resumed.");
    return {
      state: {
        contract: "card-keepr-gunzip-resume@1",
        bit: this.#bit,
        phase: this.#phase,
        final: this.#final,
        stored: this.#stored,
        lengths: this.#phase === "codes" ? this.#lengths : null,
        literals: this.#phase === "codes" ? this.#literals : 0,
        crc: this.#crc,
        decoded: this.#decoded,
        raw_hashed: this.#rawHashed,
        raw: this.#raw.checkpoint,
        output: this.#output.checkpoint,
        etag: this.#etag,
      },
      window: this.#out.slice(0, this.#history),
    };
  }

  get decodedBytes(): number {
    return this.#decoded;
  }

  /** SHA-256 of every decoded byte; available after verified EOF. */
  get decodedDigest(): string {
    if (this.#decodedDigest === null) throw new Error("Gunzip stream is incomplete.");
    return this.#decodedDigest;
  }

  /** The next decoded chunk, or null after verified EOF. */
  async next(): Promise<Uint8Array | null> {
    const start = this.#history;
    let position = start;
    while (position === start) {
      if (this.#phase === "end") return null;
      if (this.#phase === "header") await this.#header();
      else if (this.#phase === "block") await this.#blockHeader();
      else if (this.#phase === "stored") position = await this.#storedBytes(position);
      else if (this.#phase === "codes") position = await this.#codes(position);
      else {
        await this.#trailer();
        return null;
      }
    }
    const chunk = this.#out.slice(start, position);
    this.#decoded += chunk.byteLength;
    if (this.#decoded > this.#source.decompressedBytes)
      throw new SourceArchiveFailure("Decompressed archive exceeds its byte limit.");
    this.#crc = crc32(this.#crc, chunk);
    this.#output.update(chunk);
    const keep = Math.min(position, historyBytes);
    this.#out.copyWithin(0, position - keep, position);
    this.#history = keep;
    return chunk;
  }

  #available(): number {
    return this.#bufferStart + this.#buffer.byteLength - (this.#bit >>> 3);
  }

  /**
   * Unread bits from the cursor. Symbol decoding is a bit cursor, so its
   * lookahead has to be counted in bits: a cursor part-way through a byte
   * reaches one byte less far than a byte-aligned one, and comparing a byte
   * count against a bit lookahead left the decoder with a buffer it would
   * neither refill nor read from (#327).
   */
  #availableBits(): number {
    return (this.#bufferStart + this.#buffer.byteLength) * 8 - this.#bit;
  }

  /** Ensure `bits` unread bits are buffered, or report the retained end. */
  async #ensureBits(bits: number): Promise<boolean> {
    return this.#ensure(Math.ceil((bits + (this.#bit & 7)) / 8));
  }

  /** Ensure `bytes` unread bytes are buffered, or report the retained end. */
  async #ensure(bytes: number): Promise<boolean> {
    while (this.#available() < bytes) {
      const end = this.#bufferStart + this.#buffer.byteLength;
      if (end >= this.#source.length) return false;
      const length = Math.min(gunzipRangeBytes, this.#source.length - end);
      const { bytes: read, etag } = await this.#source.read(end, length);
      if (read.byteLength !== length) throw new Error("Source archive is missing or truncated.");
      if (this.#etag !== null && this.#etag !== etag) throw new Error("Source archive changed while decoding.");
      this.#etag = etag;
      if (end + length > this.#rawHashed) {
        this.#raw.update(read.subarray(Math.max(0, this.#rawHashed - end)));
        this.#rawHashed = end + length;
      }
      // Byte alignment can move the cursor past an exhausted buffer.
      const from = Math.min(this.#bit >>> 3, end);
      const kept = this.#buffer.subarray(from - this.#bufferStart);
      const merged = new Uint8Array(kept.byteLength + read.byteLength);
      merged.set(kept);
      merged.set(read, kept.byteLength);
      this.#buffer = merged;
      this.#bufferStart = from;
    }
    return true;
  }

  #bits(count: number): number {
    const index = (this.#bit >>> 3) - this.#bufferStart;
    const b = this.#buffer;
    const value =
      ((b[index] ?? 0) | ((b[index + 1] ?? 0) << 8) | ((b[index + 2] ?? 0) << 16) | ((b[index + 3] ?? 0) << 24)) >>>
      (this.#bit & 7);
    this.#bit += count;
    return count === 0 ? 0 : value & ((1 << count) - 1);
  }

  #checkTruncation(): void {
    if (this.#bit > this.#source.length * 8) corrupt();
  }

  async #byte(): Promise<number> {
    if (!(await this.#ensure(1))) corrupt();
    return this.#bits(8);
  }

  async #header(): Promise<void> {
    if (this.#bit !== 0) throw new Error("Invalid gunzip continuation state.");
    let headerCrc = 0;
    const byte = async () => {
      const value = await this.#byte();
      headerCrc = crc32(headerCrc, Uint8Array.of(value));
      return value;
    };
    if ((await byte()) !== 0x1f || (await byte()) !== 0x8b || (await byte()) !== 8) corrupt();
    const flags = await byte();
    if (flags & 0xe0) corrupt();
    for (let i = 0; i < 6; i++) await byte();
    if (flags & 4) {
      const length = (await byte()) | ((await byte()) << 8);
      for (let i = 0; i < length; i++) await byte();
    }
    for (const flag of [8, 16]) {
      if (!(flags & flag)) continue;
      for (let length = 0; ; length++) {
        if (length > 65536) corrupt();
        if ((await byte()) === 0) break;
      }
    }
    if (flags & 2) {
      const expected = (await this.#byte()) | ((await this.#byte()) << 8);
      if (expected !== (headerCrc & 0xffff)) corrupt();
    }
    this.#phase = "block";
  }

  async #blockHeader(): Promise<void> {
    await this.#ensure(headerLookahead);
    this.#final = this.#bits(1) === 1;
    const type = this.#bits(2);
    if (type === 0) {
      this.#bit = Math.ceil(this.#bit / 8) * 8;
      if (!(await this.#ensure(4))) corrupt();
      const length = this.#bits(16),
        complement = this.#bits(16);
      if ((length ^ 0xffff) !== complement) corrupt();
      this.#stored = length;
      this.#phase = length === 0 ? (this.#final ? "trailer" : "block") : "stored";
    } else if (type === 1) {
      this.#useFixed();
      this.#phase = "codes";
    } else if (type === 2) {
      const literals = this.#bits(5) + 257,
        distances = this.#bits(5) + 1,
        codeLengthCount = this.#bits(4) + 4;
      if (literals > 286 || distances > 30) corrupt();
      const codeLengths = new Uint8Array(19);
      for (let i = 0; i < codeLengthCount; i++) codeLengths[codeLengthOrder[i]!] = this.#bits(3);
      const codeTable = huffmanTable(codeLengths, 0, 19);
      const lengths: number[] = [];
      while (lengths.length < literals + distances) {
        const entry = codeTable.entries[this.#peek(codeTable.bits)]!;
        if (entry === 0) corrupt();
        this.#bit += entry & 15;
        const symbol = entry >>> 4;
        if (symbol < 16) lengths.push(symbol);
        else if (symbol === 16) {
          if (!lengths.length) corrupt();
          const previous = lengths.at(-1)!;
          for (let repeat = 3 + this.#bits(2); repeat > 0; repeat--) lengths.push(previous);
        } else
          for (let repeat = symbol === 17 ? 3 + this.#bits(3) : 11 + this.#bits(7); repeat > 0; repeat--)
            lengths.push(0);
      }
      if (lengths.length !== literals + distances || lengths[256] === 0) corrupt();
      this.#useDynamic(lengths, literals);
      this.#phase = "codes";
    } else corrupt();
    this.#checkTruncation();
  }

  #peek(bits: number): number {
    const index = (this.#bit >>> 3) - this.#bufferStart;
    const b = this.#buffer;
    const value =
      ((b[index] ?? 0) | ((b[index + 1] ?? 0) << 8) | ((b[index + 2] ?? 0) << 16) | ((b[index + 3] ?? 0) << 24)) >>>
      (this.#bit & 7);
    return value & ((1 << bits) - 1);
  }

  #useFixed(): void {
    fixedTables ??= { literal: huffmanTable(fixedLengths, 0, 288), distance: huffmanTable(fixedLengths, 288, 32) };
    this.#literal = fixedTables.literal;
    this.#distance = fixedTables.distance;
    this.#lengths = null;
    this.#literals = 0;
  }

  #useDynamic(lengths: number[], literals: number): void {
    this.#literal = huffmanTable(lengths, 0, literals);
    this.#distance = huffmanTable(lengths, literals, lengths.length - literals);
    this.#lengths = lengths;
    this.#literals = literals;
  }

  async #storedBytes(position: number): Promise<number> {
    if (this.#available() === 0 && !(await this.#ensure(1))) corrupt();
    const count = Math.min(this.#stored, this.#available(), this.#out.byteLength - maximumMatch - position);
    const from = (this.#bit >>> 3) - this.#bufferStart;
    this.#out.set(this.#buffer.subarray(from, from + count), position);
    this.#bit += count * 8;
    this.#stored -= count;
    if (this.#stored === 0) this.#phase = this.#final ? "trailer" : "block";
    return position + count;
  }

  async #codes(position: number): Promise<number> {
    const out = this.#out;
    const limit = historyBytes + gunzipChunkBytes;
    const literal = this.#literal!,
      distance = this.#distance!;
    const literalMask = (1 << literal.bits) - 1,
      distanceMask = (1 << distance.bits) - 1;
    while (position < limit) {
      // The refill demand and the decode condition are one predicate, so an
      // iteration that neither refills nor ends the stream always decodes.
      if (
        this.#availableBits() < symbolLookaheadBits &&
        !(await this.#ensureBits(symbolLookaheadBits)) &&
        this.#availableBits() <= 0
      )
        corrupt();
      // Decode synchronously while a whole symbol's bits are buffered.
      const bufferEnd = (this.#bufferStart + this.#buffer.byteLength) * 8 - symbolLookaheadBits;
      const atEnd = this.#bufferStart + this.#buffer.byteLength >= this.#source.length;
      const before = this.#bit;
      while (position < limit && (this.#bit <= bufferEnd || atEnd)) {
        const entry = literal.entries[this.#peek(literal.bits) & literalMask]!;
        if (entry === 0) corrupt();
        this.#bit += entry & 15;
        const symbol = entry >>> 4;
        if (symbol < 256) {
          out[position++] = symbol;
          continue;
        }
        if (symbol === 256) {
          this.#phase = this.#final ? "trailer" : "block";
          this.#checkTruncation();
          return position;
        }
        const index = symbol - 257;
        if (index >= 29) corrupt();
        const length = lengthBase[index]! + this.#bits(lengthExtra[index]!);
        const distanceEntry = distance.entries[this.#peek(distance.bits) & distanceMask]!;
        if (distanceEntry === 0) corrupt();
        this.#bit += distanceEntry & 15;
        const distanceSymbol = distanceEntry >>> 4;
        if (distanceSymbol >= 30) corrupt();
        const back = distanceBase[distanceSymbol]! + this.#bits(distanceExtra[distanceSymbol]!);
        // History holds min(decoded, 32 KiB) bytes, so this bounds every legal distance.
        if (back > position) corrupt();
        for (let i = 0; i < length; i++, position++) out[position] = out[position - back]!;
        if (atEnd) this.#checkTruncation();
      }
      this.#checkTruncation();
      // A decode that consumed no input would spend the step's whole CPU
      // allowance on an empty loop rather than failing the step.
      if (this.#bit === before) throw new Error("Gunzip decode stalled without consuming input.");
    }
    return position;
  }

  async #trailer(): Promise<void> {
    this.#bit = Math.ceil(this.#bit / 8) * 8;
    if (!(await this.#ensure(8))) corrupt();
    const crc = (this.#bits(16) | (this.#bits(16) << 16)) >>> 0;
    const size = (this.#bits(16) | (this.#bits(16) << 16)) >>> 0;
    if (crc !== this.#crc || size !== this.#decoded % 2 ** 32) corrupt();
    // One member exactly covers the retained bytes; anything after is not evidence.
    if (this.#bit >>> 3 !== this.#source.length) corrupt();
    if (this.#rawHashed !== this.#source.length || this.#raw.digestHex() !== this.#source.sha256)
      throw new Error("Source archive failed exact-byte verification.");
    this.#decodedDigest = this.#output.digestHex();
    this.#phase = "end";
  }
}
