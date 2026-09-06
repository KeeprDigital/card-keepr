type SearchableCard = Readonly<{
  official_identity: Readonly<{ value: string | null }>;
  name: string;
  effective_rules_text?: string | null;
}>;

export type CardSearchChunk = Readonly<{
  field: number;
  ordinal: number;
  text: string;
}>;

// FTS handles normalized queries of three or more scalars; shorter
// literal queries use the same field-separated chunks directly.
const minimumFtsQueryCodePoints = 3;
// Unicode NFKC expands one scalar to at most 18 scalars in the runtime's
// Unicode data. A 500-scalar query therefore remains below this overlap.
const maximumNormalizedQueryCodePoints = 9 * 1024;
const maximumChunkCodePoints = 12 * 1024;
const chunkStride = maximumChunkCodePoints - maximumNormalizedQueryCodePoints + 1;

export function cardSearchText(card: SearchableCard): string {
  return JSON.stringify([
    normalizeSearchText(card.official_identity.value ?? ""),
    normalizeSearchText(card.name),
    normalizeSearchText(card.effective_rules_text ?? ""),
  ]);
}

export function cardSearchChunks(searchDocument: string): CardSearchChunk[] {
  return searchFields(searchDocument).flatMap((field, fieldIndex) => {
    const points = [...field];
    if (points.length === 0) return [];
    const chunks: CardSearchChunk[] = [];
    for (let start = 0, ordinal = 0; start < points.length; start += chunkStride, ordinal += 1) {
      chunks.push({
        field: fieldIndex,
        ordinal,
        text: points.slice(start, start + maximumChunkCodePoints).join(""),
      });
      if (start + maximumChunkCodePoints >= points.length) break;
    }
    return chunks;
  });
}

export function cardSearchQuery(value: string | null): { text: string } | null {
  if (value === null) return null;
  const text = normalizeSearchText(value);
  if (text.length === 0) return null;
  return {
    text,
  };
}

export function cardSearchFtsQuery(value: string, revisionId: string): string | null {
  const text = normalizeSearchText(value);
  if ([...text].length < minimumFtsQueryCodePoints) return null;
  return `revision_token : ${ftsLiteral(revisionToken(revisionId))} AND ` + `search_text : ${ftsLiteral(text)}`;
}

function revisionToken(revisionId: string): string {
  return `|${revisionId}|`;
}

function ftsLiteral(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function searchFields(document: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((field) => typeof field !== "string")) {
    throw new Error("The Card search document is invalid.");
  }
  return parsed;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").normalize("NFKC");
}
