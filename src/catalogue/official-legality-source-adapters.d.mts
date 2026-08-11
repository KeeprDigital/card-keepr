export type OfficialLegalityParseOptions = Readonly<{
  allowUnresolvedTargetScope?: boolean;
}>;
export const openPredicateUnresolvedReason: string;
export function officialLegalityRulesObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  rawDocument: Record<string, unknown>,
  options?: OfficialLegalityParseOptions,
): Record<string, unknown>;
export function officialLiveLegalityRulesObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  rawDocument: Record<string, unknown>,
  options?: OfficialLegalityParseOptions,
): Record<string, unknown>;
export function officialLegalityRulesHtmlObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  html: string,
  options?: OfficialLegalityParseOptions,
): Record<string, unknown> | null;
