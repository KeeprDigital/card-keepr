import type { SupportedGame } from "./catalogue-candidate";
import type { LegalityRegion } from "./legality-rule";

export type OfficialSourceScope = Readonly<{
  sourceLineage: string;
  game: SupportedGame;
  legalityRegion: LegalityRegion;
}>;

const scopes: readonly OfficialSourceScope[] = Object.freeze([
  Object.freeze({
    sourceLineage: "one-piece-en",
    game: "one-piece",
    legalityRegion: "EN-OCEANIA",
  }),
  Object.freeze({
    sourceLineage: "fusion-world-en",
    game: "fusion-world",
    legalityRegion: "EN-OCEANIA",
  }),
  Object.freeze({
    sourceLineage: "digimon-en",
    game: "digimon",
    legalityRegion: "EN-OCEANIA",
  }),
  Object.freeze({
    sourceLineage: "gundam-en-asia",
    game: "gundam",
    legalityRegion: "EN-ASIA",
  }),
  Object.freeze({
    sourceLineage: "gundam-en-us",
    game: "gundam",
    legalityRegion: "EN-US",
  }),
]);

export function requiredOfficialSourceScope(
  sourceLineage: string,
): OfficialSourceScope {
  const scope = scopes.find(
    (candidate) => candidate.sourceLineage === sourceLineage,
  );
  if (scope === undefined) {
    throw new Error("Official Source Lineage has no registered scope.");
  }
  return scope;
}
