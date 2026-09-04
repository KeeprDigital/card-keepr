import { AdapterParseFailure } from "./adapter-parse-failure";
import type { LegalityRegion, SupportedGame } from "../shared";

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

export function requiredOfficialSourceScope(sourceLineage: string): OfficialSourceScope {
  const scope = scopes.find((entry) => entry.sourceLineage === sourceLineage);
  if (scope === undefined) {
    throw new AdapterParseFailure("Official Source Lineage has no registered scope.", { category: "configuration" });
  }
  return scope;
}

export function requiredLegalityRegionsForGame(game: SupportedGame): readonly LegalityRegion[] {
  const regions = [
    ...new Set(scopes.filter((scope) => scope.game === game).map((scope) => scope.legalityRegion)),
  ].sort();
  if (regions.length === 0) {
    throw new AdapterParseFailure("Supported Game has no registered Official Source scope.", {
      category: "configuration",
    });
  }
  return regions;
}
