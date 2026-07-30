type SearchableCard = Readonly<{
  official_identity: Readonly<{ value: string }>;
  name: string;
  effective_rules_text?: string | null;
}>;

export type CardSearchChunk = Readonly<{
  field: number;
  ordinal: number;
  text: string;
}>;

// Keep one compact, indexed candidate signature per observed hash bucket.
// Exact matching still happens against field-separated search chunks, so
// collisions affect only candidate-set size rather than search semantics.
const candidateBucketCount = 16;
const maximumGramLength = 3;
// Unicode NFKC expands one scalar to at most 18 scalars in the runtime's
// Unicode data. A 500-scalar query therefore remains below this overlap.
const maximumNormalizedQueryCodePoints = 9 * 1024;
const maximumChunkCodePoints = 12 * 1024;
const chunkStride =
  maximumChunkCodePoints - maximumNormalizedQueryCodePoints + 1;

export function cardSearchText(card: SearchableCard): string {
  return JSON.stringify([
    normalizeSearchText(card.official_identity.value),
    normalizeSearchText(card.name),
    normalizeSearchText(card.effective_rules_text ?? ""),
  ]);
}

export function cardSearchTerms(searchDocument: string): string[] {
  const terms = new Set<string>();
  for (const field of searchFields(searchDocument)) {
    const points = [...field];
    for (let index = 0; index < points.length; index += 1) {
      for (
        let length = 1;
        length <= maximumGramLength && index + length <= points.length;
        length += 1
      ) {
        terms.add(searchBucket(points.slice(index, index + length).join("")));
      }
    }
  }
  return [...terms].sort();
}

export function cardSearchChunks(
  searchDocument: string,
): CardSearchChunk[] {
  return searchFields(searchDocument).flatMap((field, fieldIndex) => {
    const points = [...field];
    if (points.length === 0) return [];
    const chunks: CardSearchChunk[] = [];
    for (
      let start = 0, ordinal = 0;
      start < points.length;
      start += chunkStride, ordinal += 1
    ) {
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

export function cardSearchQuery(
  value: string | null,
): { text: string; anchorTerm: string } | null {
  if (value === null) return null;
  const text = normalizeSearchText(value);
  if (text.length === 0) return null;
  return {
    text,
    anchorTerm: searchBucket(
      [...text].slice(0, maximumGramLength).join(""),
    ),
  };
}

function searchFields(document: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    parsed = null;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    parsed.some((field) => typeof field !== "string")
  ) {
    throw new Error("The Card search document is invalid.");
  }
  return parsed;
}

function searchBucket(value: string): string {
  let hash = 0x811c9dc5;
  for (const point of value) {
    const codePoint = point.codePointAt(0)!;
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `g${[...value].length}:${
    String(hash % candidateBucketCount).padStart(4, "0")
  }`;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .normalize("NFKC");
}
