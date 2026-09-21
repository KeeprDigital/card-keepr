import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { decodeFlightPayload, flightElements, resolveFlightReferences } from "./next-flight-payload";

// Piltover Archive renders its public gallery (`/cards`, `/cards?page=N`) as a
// Next.js page whose flight payload hands the grid component a `variants`
// list: one record per displayed variant with its set, card facts, art
// locator, treatment labels and marketplace fields. This parser reads that
// retained render; it is observed website output, not a documented API.

export const piltoverArchiveOrigin = "https://piltoverarchive.com";
const galleryPath = "/cards";
const bounds = { rows: 200, text: 4096, values: 256, list: 32 };

export type PiltoverVariant = Readonly<{
  source_key: string;
  variant_number: string;
  rarity: string;
  variant_type: string;
  variant_types: readonly string[];
  variant_label: string;
  foil_mode: string;
  image_url: string;
  flavor_text: string | null;
  artist: string | null;
  release_date: string | null;
  parent_variant_id: string | null;
  set: Readonly<{ id: string; name: string; prefix: string; release_date: string | null }>;
  card: Readonly<{
    id: string;
    name: string;
    types: readonly string[];
    type: string;
    super: string | null;
    description: string | null;
    energy: number | null;
    might: number | null;
    power: number | null;
    tags: readonly string[];
    attach_text: string | null;
    effect: string | null;
    might_bonus: number | null;
    colors: readonly string[];
  }>;
  /** The complete source record, including fields this pilot does not map. */
  record: Readonly<Record<string, unknown>>;
}>;

export type PiltoverGalleryPage = Readonly<{
  url: string;
  page: number;
  pages: number;
  total: string;
  rows: readonly PiltoverVariant[];
}>;

export function piltoverGalleryPageNumber(value: string): number {
  const url = adapterUrl(value);
  const page = url.searchParams.get("page");
  if (
    url.origin !== piltoverArchiveOrigin ||
    url.pathname !== galleryPath ||
    url.hash ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((key) => key !== "page") ||
    (page !== null && !/^[1-9]\d{0,2}$/u.test(page))
  )
    throw new AdapterParseFailure("Piltover Archive request is outside the registered public gallery.");
  return page === null ? 1 : Number(page);
}

export function parsePiltoverGalleryPage(html: string, url: string): PiltoverGalleryPage {
  const expectedPage = piltoverGalleryPageNumber(url);
  const chunks = decodeFlightPayload(html);
  let variants: unknown[] | undefined, paging: Record<string, unknown> | undefined;
  for (const value of chunks.values()) {
    if (typeof value !== "object" || value === null) continue;
    const resolved = resolveFlightReferences(chunks, value);
    variants ??= flightElements(resolved, (element) => Array.isArray(element[3].variants))[0]?.[3].variants as
      unknown[] | undefined;
    paging ??= flightElements(resolved, (element) => "currentPage" in element[3] && "totalPages" in element[3])[0]?.[3];
    if (variants && paging) break;
  }
  if (!variants || !paging) throw new AdapterParseFailure("Piltover Archive gallery grid or pagination is missing.");
  const { currentPage, totalPages, hasNext, hasPrevious } = paging;
  if (
    !Number.isSafeInteger(currentPage) ||
    !Number.isSafeInteger(totalPages) ||
    Number(currentPage) !== expectedPage ||
    Number(totalPages) < expectedPage ||
    hasNext !== Number(totalPages) > expectedPage ||
    hasPrevious !== expectedPage > 1
  )
    throw new AdapterParseFailure("Piltover Archive gallery pagination contract changed.");
  // The rendered filter bar states the gallery total ("1,240" then "cards").
  const total = /<span[^>]*>([1-9]\d{0,2}(?:,\d{3})*)<\/span><span[^>]*>cards<\/span>/u.exec(html)?.[1];
  if (total === undefined) throw new AdapterParseFailure("Piltover Archive gallery total is missing.");
  if (variants.length === 0 || variants.length > bounds.rows)
    throw new AdapterParseFailure("Piltover Archive gallery page is empty or exceeds its row bound.");
  const keys = new Set<string>();
  const rows = variants.map((value) => {
    const row = variant(value);
    if (keys.has(row.source_key)) throw new AdapterParseFailure("Piltover Archive repeats a variant identifier.");
    keys.add(row.source_key);
    return row;
  });
  return { url, page: Number(currentPage), pages: Number(totalPages), total, rows };
}

function variant(value: unknown): PiltoverVariant {
  const record = object(value);
  const set = object(record.set);
  const card = object(record.card);
  const image = adapterUrl(text(record.imageUrl));
  if (image.protocol !== "https:") throw new AdapterParseFailure("Piltover Archive art locator is not HTTPS.");
  return {
    source_key: uuid(record.id),
    variant_number: text(record.variantNumber),
    rarity: text(record.rarity),
    variant_type: text(record.variantType),
    variant_types: nullableTexts(record.variantTypes),
    variant_label: text(record.variantLabel),
    foil_mode: text(record.foilMode),
    image_url: image.href,
    flavor_text: nullableText(record.flavorText, bounds.text),
    artist: nullableText(record.artist),
    release_date: nullableText(record.releaseDate),
    parent_variant_id: record.parentVariantId === null ? null : uuid(record.parentVariantId),
    set: {
      id: uuid(set.id),
      name: text(set.name),
      prefix: text(set.prefix),
      release_date: nullableText(set.releaseDate),
    },
    card: {
      id: uuid(card.id),
      name: text(card.name),
      types: nullableTexts(card.types),
      type: text(card.type),
      super: nullableText(card.super),
      description: nullableText(card.description, bounds.text),
      energy: nullableInteger(card.energy),
      might: nullableInteger(card.might),
      power: nullableInteger(card.power),
      tags: nullableTexts(card.tags),
      attach_text: nullableText(card.attachText, bounds.text),
      effect: nullableText(card.effect, bounds.text),
      might_bonus: nullableInteger(card.mightBonus),
      colors: (card.colors === null ? [] : list(card.colors)).map((color) => text(object(color).name)),
    },
    record,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("Piltover Archive record is not an object.");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > bounds.list)
    throw new AdapterParseFailure("Piltover Archive list is missing or exceeds its bound.");
  return value;
}
function nullableTexts(value: unknown): string[] {
  return value === null || value === undefined ? [] : list(value).map((entry) => text(entry));
}
function text(value: unknown, maximum = bounds.values): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new AdapterParseFailure("Piltover Archive text is missing or exceeds its bound.");
  return value;
}
function nullableText(value: unknown, maximum = bounds.values): string | null {
  return value === null || value === undefined ? null : text(value, maximum);
}
function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new AdapterParseFailure("Piltover Archive numeric field is not a non-negative integer.");
  return Number(value);
}
function uuid(value: unknown): string {
  const id = text(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id))
    throw new AdapterParseFailure("Piltover Archive identifier is not a UUID.");
  return id;
}
