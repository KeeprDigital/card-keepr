import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";

export const scryfallBulkMetadataUrl = "https://api.scryfall.com/bulk-data";
export const scryfallArchiveLimits = Object.freeze({
  compressedBytes: 96 * 1024 * 1024,
  decompressedBytes: 1024 * 1024 * 1024,
  recordBytes: 128 * 1024,
  records: 150_000,
});

export type ScryfallBulkPin = Readonly<{
  url: string;
  timestamp: string;
  cutoff: string;
  compressedBytes: number;
}>;

export function scryfallCapturedBulkPin(context: { url: string; requestId: string; compressedBytes: number }) {
  const identity = /^scryfall-magic-en:listing:bulk-(\d{14})-(\d+):[a-f0-9]{64}$/u.exec(context.requestId);
  const stamp = identity?.[1];
  if (
    !stamp ||
    Number(identity?.[2]) !== context.compressedBytes ||
    context.compressedBytes < 1 ||
    context.compressedBytes > scryfallArchiveLimits.compressedBytes ||
    context.url !== `https://data.scryfall.io/default-cards/default-cards-${stamp}.jsonl.gz`
  )
    throw new AdapterParseFailure("Captured Scryfall archive disagrees with its immutable metadata pin.");
  const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
  const instant = `${date}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  if (!Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant)
    throw new AdapterParseFailure("Captured Scryfall archive timestamp is invalid.");
  return { cutoff: date, limits: { ...scryfallArchiveLimits, compressedBytes: context.compressedBytes } };
}

/** A metadata response selects one printing-bearing snapshot; it is not an inventory itself. */
export function scryfallBulkPin(bytes: Uint8Array): ScryfallBulkPin {
  const document: unknown = withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes)));
  if (!isRecord(document) || document.object !== "list" || !Array.isArray(document.data) || document.has_more !== false)
    throw new AdapterParseFailure("Scryfall bulk metadata must be a complete list.");
  const defaults = document.data.filter((item) => isRecord(item) && item.type === "default_cards");
  const selected: unknown = defaults[0];
  if (
    defaults.length !== 1 ||
    !isRecord(selected) ||
    selected.object !== "bulk_data" ||
    selected.id !== "e2ef41e3-5778-4bc2-af3f-78eca4dd9c23"
  )
    throw new AdapterParseFailure("Scryfall metadata requires exactly one default_cards archive.");
  const match =
    typeof selected.jsonl_download_uri === "string"
      ? /^https:\/\/data\.scryfall\.io\/default-cards\/default-cards-(\d{14})\.jsonl\.gz$/u.exec(
          selected.jsonl_download_uri,
        )
      : null;
  const stamp = match?.[1];
  const updated = typeof selected.updated_at === "string" ? new Date(selected.updated_at) : null;
  const validTime = updated !== null && Number.isFinite(updated.getTime());
  if (!stamp || !validTime || updated.toISOString().replaceAll(/[-:]/gu, "").slice(0, 15).replace("T", "") !== stamp)
    throw new AdapterParseFailure("Scryfall gzip JSONL URL must match its metadata timestamp.");
  const size = selected.compressed_size;
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > scryfallArchiveLimits.compressedBytes
  )
    throw new AdapterParseFailure("Scryfall compressed archive exceeds its finite capture limit.");
  return {
    url: String(selected.jsonl_download_uri),
    timestamp: stamp,
    cutoff: updated.toISOString().slice(0, 10),
    compressedBytes: size,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
