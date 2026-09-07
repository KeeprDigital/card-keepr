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
