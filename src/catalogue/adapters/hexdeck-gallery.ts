import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { decodeFlightPayload, flightElements, resolveFlightReferences } from "./next-flight-payload";

// HexDeck renders its card search (`/cards?...`) as a Next.js page whose flight
// payload hands the results component a `results` list with the page's
// pagination and sort state. This parser reads that retained render; it is
// observed website output, not a documented API.

export const hexdeckOrigin = "https://www.hexdeck.io";
const bounds = { rows: 200, values: 256, list: 32 };

export type HexdeckListing = Readonly<{
  source_key: string;
  name: string;
  set_tag: string;
  set_number: string;
  rarity: string;
  energy: number | null;
  might: number | null;
  power: number | null;
  might_bonus: number | null;
  image_url: string;
  /** The `standard` delivery variant the page itself renders for this listing, when present. */
  art_url: string | null;
  domains: readonly string[];
  types: readonly string[];
  supertypes: readonly string[];
  search_tags: readonly string[];
  /** The complete source record, including fields this pilot does not map. */
  record: Readonly<Record<string, unknown>>;
}>;

export type HexdeckSearchPage = Readonly<{
  url: string;
  display_format: string;
  sort_field: string;
  sort_direction: string;
  current_page: number;
  page_size: number;
  total_count: number;
  rows: readonly HexdeckListing[];
}>;

export function parseHexdeckSearchPage(html: string, url: string): HexdeckSearchPage {
  const request = adapterUrl(url);
  if (request.origin !== hexdeckOrigin || request.pathname !== "/cards" || request.hash)
    throw new AdapterParseFailure("HexDeck request is outside the registered card search.");
  const chunks = decodeFlightPayload(html);
  let props: Record<string, unknown> | undefined;
  for (const value of chunks.values()) {
    if (typeof value !== "object" || value === null) continue;
    props = flightElements(
      resolveFlightReferences(chunks, value),
      (element) => Array.isArray(element[3].results) && "totalCount" in element[3],
    )[0]?.[3];
    if (props) break;
  }
  if (!props) throw new AdapterParseFailure("HexDeck search results are missing.");
  const { results, currentPage, pageSize, totalCount } = props;
  const expectedPage = Number(request.searchParams.get("page") ?? "1");
  if (
    !Array.isArray(results) ||
    !Number.isSafeInteger(currentPage) ||
    !Number.isSafeInteger(pageSize) ||
    !Number.isSafeInteger(totalCount) ||
    Number(currentPage) !== expectedPage ||
    Number(pageSize) < 1 ||
    Number(pageSize) > bounds.rows ||
    results.length > Number(pageSize) ||
    results.length > Number(totalCount) ||
    (results.length < Number(pageSize) && Number(currentPage) * Number(pageSize) < Number(totalCount))
  )
    throw new AdapterParseFailure("HexDeck pagination contract changed.");
  const keys = new Set<string>();
  const rows = results.map((value) => {
    const row = listing(value, html);
    if (keys.has(row.source_key)) throw new AdapterParseFailure("HexDeck repeats a card identifier.");
    keys.add(row.source_key);
    return row;
  });
  return {
    url,
    display_format: text(props.displayFormat),
    sort_field: text(props.sortField),
    sort_direction: text(props.sortDirection),
    current_page: Number(currentPage),
    page_size: Number(pageSize),
    total_count: Number(totalCount),
    rows,
  };
}

function listing(value: unknown, html: string): HexdeckListing {
  const record = object(value);
  const image = adapterUrl(text(record.imageUrl));
  if (image.protocol !== "https:") throw new AdapterParseFailure("HexDeck art locator is not HTTPS.");
  // The JSON locator is a Cloudflare Images base; the rendered markup appends a
  // named variant. Only a variant the page actually references is retained.
  const standard = `${image.href}standard`;
  return {
    source_key: text(record.uuid),
    name: text(record.name),
    set_tag: text(record.setTag),
    set_number: text(record.setNumber),
    rarity: text(record.rarity),
    energy: nullableInteger(record.energy),
    might: nullableInteger(record.might),
    power: nullableInteger(record.power),
    might_bonus: nullableInteger(record.mightBonus),
    image_url: image.href,
    art_url: html.includes(`"${standard}`) || html.includes(`${standard} `) ? standard : null,
    domains: names(record.domain),
    types: names(record.types),
    supertypes: names(record.superTypes),
    search_tags: names(record.searchTags),
    record,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("HexDeck record is not an object.");
  return value as Record<string, unknown>;
}
function names(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > bounds.list)
    throw new AdapterParseFailure("HexDeck list is missing or exceeds its bound.");
  return value.map((entry) => text(object(entry).name));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > bounds.values)
    throw new AdapterParseFailure("HexDeck text is missing or exceeds its bound.");
  return value;
}
function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new AdapterParseFailure("HexDeck numeric field is not a non-negative integer.");
  return Number(value);
}
