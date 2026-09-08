// Unwired capacity experiment. Differential tests bind this prototype to the
// production serializer; measurements did not establish a peak-memory benefit.
import { compareUtf8 } from "../../src/catalogue/shared/serialization.ts";
const encoder = new TextEncoder();

/** Encode a stable JSON data tree without retaining a whole canonical string.
 * Both passes are synchronous; callers must not supply changing getters/proxies.
 * The existing string encoder remains the canonical byte/error reference.
 */
export function canonicalUtf8(value: unknown): Uint8Array {
  let length = 0;
  visitCanonicalParts(value, "$", (part) => {
    length += encodedLength(part);
  });
  const result = new Uint8Array(length);
  let offset = 0;
  visitCanonicalParts(value, "$", (part) => {
    if (part.length === 1 && part.charCodeAt(0) < 0x80) {
      if (offset >= length) throw new Error("Canonical JSON input changed during encoding.");
      result[offset++] = part.charCodeAt(0);
      return;
    }
    const encoded = encoder.encodeInto(part, result.subarray(offset));
    if (encoded.read !== part.length) throw new Error("Canonical JSON input changed during encoding.");
    offset += encoded.written;
  });
  if (offset !== length) throw new Error("Canonical JSON input changed during encoding.");
  return result;
}

function visitCanonicalParts(value: unknown, path: string, emit: (part: string) => void): void {
  if (typeof value === "string") {
    emit('"');
    const normalized = value.normalize("NFC");
    for (let offset = 0; offset < normalized.length; ) {
      let end = Math.min(offset + 32768, normalized.length);
      if (
        end < normalized.length &&
        normalized.charCodeAt(end - 1) >= 0xd800 &&
        normalized.charCodeAt(end - 1) <= 0xdbff
      )
        end--;
      emit(JSON.stringify(normalized.slice(offset, end)).slice(1, -1));
      offset = end;
    }
    emit('"');
  } else if (Array.isArray(value)) {
    emit("[");
    for (let index = 0; index < value.length; index++) {
      if (index) emit(",");
      // Array.map in the reference skips holes, but visits inherited elements.
      if (index in value) visitCanonicalParts(value[index], `${path}[${index}]`, emit);
    }
    emit("]");
  } else if (value !== null && typeof value === "object") {
    emit("{");
    let first = true;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record).sort(compareUtf8)) {
      if (!first) emit(",");
      first = false;
      visitCanonicalParts(key, path, emit);
      emit(":");
      visitCanonicalParts(record[key], `${path}.${key}`, emit);
    }
    emit("}");
  } else {
    emit(canonicalScalar(value, path));
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

function canonicalScalar(value: unknown, path: string): string {
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isInteger(value)))
    throw new Error(`Canonical catalogue JSON permits finite integers only at ${path}`);
  if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  throw new Error(`Canonical catalogue JSON contains an unsupported value at ${path}`);
}
