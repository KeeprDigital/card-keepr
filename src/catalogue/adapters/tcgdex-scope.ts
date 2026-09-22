import { AdapterParseFailure, decodeAdapterUtf8, withAdapterParseFailure } from "./adapter-parse-failure";

const api = "https://api.tcgdex.net/v2/en";
const maximumSets = 512;
const maximumCardsPerSet = 1024;
// Every English series in the retained 2026-09-15 inventory other than Pocket
// (tcgp) is issued physical product (#329 census). A series first seen later
// stays unresolved until it is classified explicitly.
const physicalSeries = new Set([
  "base",
  "bw",
  "col",
  "dp",
  "ecard",
  "ex",
  "gym",
  "hgss",
  "lc",
  "mc",
  "me",
  "misc",
  "neo",
  "pl",
  "pop",
  "sm",
  "sv",
  "swsh",
  "tk",
  "xy",
]);

type SetSummary = Readonly<{
  id: string;
  sourceReportedRecords: number;
  officialCount: number;
  url: string;
}>;

/** Discovery counts describe source records, never issued Cards or Printings. */
export function tcgdexScopeInventory(setsBytes: Uint8Array, pocketBytes: Uint8Array, issuedCutoff: string) {
  date(issuedCutoff);
  const summaries = tcgdexEnglishSetInventory(setsBytes);
  const pocket = record(decode(pocketBytes));
  if (pocket.id !== "tcgp") throw new AdapterParseFailure("TCGdex Pocket discovery has changed identity.");
  const excludedPocket = list(pocket.sets, maximumSets).map(setSummary);
  const byId = uniqueSets(summaries);
  uniqueSets(excludedPocket);
  for (const excluded of excludedPocket) {
    const summary = byId.get(excluded.id);
    if (
      !summary ||
      summary.sourceReportedRecords !== excluded.sourceReportedRecords ||
      summary.officialCount !== excluded.officialCount
    )
      throw new AdapterParseFailure("TCGdex Pocket membership or counts disagree with the English inventory.");
  }
  const pocketIds = new Set(excludedPocket.map((set) => set.id));
  const sets = summaries.filter((set) => !pocketIds.has(set.id));
  return {
    issuedCutoff,
    sets,
    excludedPocket,
    sourceReportedRecords: sets.reduce((sum, set) => sum + set.sourceReportedRecords, 0),
    qualifySet(bytes: Uint8Array, url: string) {
      const detail = record(decode(bytes));
      const summary = byId.get(text(detail.id));
      if (!summary || summary.url !== url || pocketIds.has(summary.id))
        throw new AdapterParseFailure("TCGdex set detail is outside the retained candidate inventory.");
      return qualifySet(detail, summary, issuedCutoff);
    },
  };
}

export function tcgdexEnglishSetInventory(bytes: Uint8Array) {
  const summaries = list(decode(bytes), maximumSets).map(setSummary);
  uniqueSets(summaries);
  return summaries;
}

function qualifySet(detail: Record<string, unknown>, summary: SetSummary, issuedCutoff: string) {
  const seriesId = text(record(detail.serie).id);
  const cards = list(detail.cards, maximumCardsPerSet).map((value) => {
    const card = record(value);
    const id = text(card.id);
    const localId = text(card.localId);
    if (id !== `${summary.id}-${localId}`)
      throw new AdapterParseFailure(
        "TCGdex Card membership disagrees with its separately evidenced set/local boundary.",
      );
    return { id, localId, url: `${api}/cards/${encodeURIComponent(id)}` };
  });
  const counts = record(detail.cardCount);
  if (
    integer(counts.total) !== summary.sourceReportedRecords ||
    integer(counts.official) !== summary.officialCount ||
    Math.max(summary.officialCount, cards.length) !== summary.sourceReportedRecords ||
    new Set(cards.map((card) => card.id)).size !== cards.length
  )
    throw new AdapterParseFailure("TCGdex set membership is duplicated, incomplete or has count drift.");
  const releaseDate = optionalDate(detail.releaseDate);
  const reason = !physicalSeries.has(seriesId)
    ? "unresolved_series"
    : releaseDate === null
      ? "unresolved_release_date"
      : releaseDate > issuedCutoff
        ? "not_yet_issued"
        : null;
  return {
    id: summary.id,
    seriesId,
    releaseDate,
    eligibility: reason === null ? "issued_set_candidate" : reason === "not_yet_issued" ? reason : "unresolved",
    reason,
    cards,
    sourceCountGap:
      cards.length < summary.sourceReportedRecords
        ? {
            officialCount: summary.officialCount,
            reportedTotal: summary.sourceReportedRecords,
            enumeratedRecords: cards.length,
          }
        : null,
  };
}

function optionalDate(value: unknown) {
  try {
    return date(value);
  } catch {
    return null;
  }
}

function uniqueSets(sets: readonly SetSummary[]) {
  const byId = new Map(sets.map((set) => [set.id, set]));
  if (byId.size !== sets.length) throw new AdapterParseFailure("TCGdex inventory repeats a set membership.");
  return byId;
}

function setSummary(value: unknown): SetSummary {
  const set = record(value);
  const id = text(set.id);
  const count = record(set.cardCount);
  return {
    id,
    sourceReportedRecords: integer(count.total),
    officialCount: integer(count.official),
    url: `${api}/sets/${encodeURIComponent(id)}`,
  };
}

function decode(bytes: Uint8Array): unknown {
  return withAdapterParseFailure(() => JSON.parse(decodeAdapterUtf8(bytes)));
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new AdapterParseFailure("TCGdex scope requires an object.");
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new AdapterParseFailure("TCGdex scope array is missing or exceeds its bound.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new AdapterParseFailure("TCGdex scope identifier is missing or exceeds its bound.");
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new AdapterParseFailure("TCGdex source count is invalid.");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new AdapterParseFailure("TCGdex issued cutoff or release date is invalid.");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    throw new AdapterParseFailure("TCGdex issued cutoff or release date is invalid.");
  return value;
}
