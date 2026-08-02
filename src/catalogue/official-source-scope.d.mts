export type OfficialSourceScope = Readonly<{
  sourceLineage: string;
  game: "one-piece" | "fusion-world" | "digimon" | "gundam";
  legalityRegion: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
}>;

export function requiredOfficialSourceScope(
  sourceLineage: string,
): OfficialSourceScope;
export function requiredLegalityRegionsForGame(
  game: OfficialSourceScope["game"],
): readonly OfficialSourceScope["legalityRegion"][];
