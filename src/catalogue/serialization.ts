import { Deflate, GZheader, zlibDeflateSetHeader } from "pako";

const encoder = new TextEncoder();
const zFixed = 4;
const zOk = 0;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(record[key])}`,
      )
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || !Number.isInteger(value))
  ) {
    throw new Error("Canonical catalogue JSON permits finite integers only");
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  throw new Error("Canonical catalogue JSON contains an unsupported value");
}

export function canonicalNdjson(records: readonly unknown[]): Uint8Array {
  return encoder.encode(records.map((record) => canonicalJson(record)).join("\n") + (records.length > 0 ? "\n" : ""));
}

export function deterministicGzip(value: Uint8Array): Uint8Array {
  const compressor = new Deflate({
    gzip: true,
    level: 9,
    windowBits: 15,
    memLevel: 8,
    strategy: zFixed,
  });
  compressor.onStart = (stream) => {
    const header = new GZheader();
    header.time = 0;
    header.os = 0xff;
    if (zlibDeflateSetHeader(stream, header) !== zOk) {
      throw new Error("The deterministic gzip header was rejected.");
    }
  };
  if (!compressor.push(value, true) || compressor.err !== zOk) {
    throw new Error(
      compressor.msg || "The deterministic gzip compressor failed.",
    );
  }
  return Uint8Array.from(compressor.result);
}

export async function sha256(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function sha256Text(value: string): Promise<string> {
  return sha256(encoder.encode(value));
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
