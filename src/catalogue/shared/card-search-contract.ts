/** Shared preparation/read search contract; a 500-scalar query can expand under NFKC. */
export const maximumNormalizedSearchQueryCodePoints = 9 * 1024;
export const maximumSearchChunkCodePoints = 12 * 1024;
export const searchChunkStride = maximumSearchChunkCodePoints - maximumNormalizedSearchQueryCodePoints + 1;
export function normalizeCardSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").normalize("NFKC");
}
