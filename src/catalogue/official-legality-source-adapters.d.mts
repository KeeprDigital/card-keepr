export function officialLegalityRulesObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  rawDocument: Record<string, unknown>,
): Record<string, unknown>;
export function officialLiveLegalityRulesObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  rawDocument: Record<string, unknown>,
): Record<string, unknown>;
export function officialLegalityRulesHtmlObservation(
  game: "one-piece" | "fusion-world" | "digimon" | "gundam",
  sourceLineage: string,
  html: string,
): Record<string, unknown> | null;
