const encoder = new TextEncoder();

export function canonicalJson(value: unknown): string {
  return canonicalJsonAt(value, "$");
}

function canonicalJsonAt(value: unknown, path: string): string {
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJsonAt(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    return `{${keys
      .map((key) => `${JSON.stringify(key.normalize("NFC"))}:${canonicalJsonAt(record[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC"));
  }
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isInteger(value))) {
    throw new Error(`Canonical catalogue JSON permits finite integers only at ${path}`);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  throw new Error(`Canonical catalogue JSON contains an unsupported value at ${path}`);
}

/** Encode a stable JSON data tree without retaining a whole canonical string.
 * Both passes are synchronous; callers must not supply changing getters/proxies.
 * The existing string encoder remains the canonical byte/error reference.
 */
export function canonicalUtf8(value: unknown): Uint8Array {
  let length = 0;
  for (const part of canonicalJsonParts(value, "$")) length += encodedLength(part);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of canonicalJsonParts(value, "$")) {
    const encoded = encoder.encodeInto(part, result.subarray(offset));
    if (encoded.read !== part.length) throw new Error("Canonical JSON input changed during encoding.");
    offset += encoded.written;
  }
  if (offset !== length) throw new Error("Canonical JSON input changed during encoding.");
  return result;
}

function* canonicalJsonParts(value: unknown, path: string): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    const normalized = value.normalize("NFC");
    for (let offset = 0; offset < normalized.length; ) {
      let end = Math.min(offset + 32768, normalized.length);
      if (
        end < normalized.length &&
        normalized.charCodeAt(end - 1) >= 0xd800 &&
        normalized.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      yield JSON.stringify(normalized.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index) yield ",";
      // Array.map in the reference skips holes, but visits inherited elements.
      if (index in value) yield* canonicalJsonParts(value[index], `${path}[${index}]`);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort(compareUtf8)) {
      if (!first) yield ",";
      first = false;
      yield* canonicalJsonParts(key, path);
      yield ":";
      yield* canonicalJsonParts(record[key], `${path}.${key}`);
    }
    yield "}";
  } else {
    yield canonicalJsonAt(value, path);
  }
}

function encodedLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export function canonicalNdjson(records: readonly unknown[]): Uint8Array {
  return encoder.encode(records.map((record) => canonicalJson(record)).join("\n") + (records.length > 0 ? "\n" : ""));
}

export async function sha256(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sha256Text(value: string): Promise<string> {
  return sha256(encoder.encode(value));
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function compareUtf8(left: string, right: string): number {
  // ASCII has identical UTF-16 and UTF-8 order and is already NFC. Catalogue
  // field names dominate these comparisons, so avoid two byte allocations.
  if (!/[\u0080-\uffff]/.test(left) && !/[\u0080-\uffff]/.test(right)) return left < right ? -1 : left > right ? 1 : 0;
  const leftBytes = encoder.encode(left.normalize("NFC"));
  const rightBytes = encoder.encode(right.normalize("NFC"));
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}
