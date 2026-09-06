import { AdapterParseFailure } from "./adapter-parse-failure";
import type { SupportedGame } from "../shared";

export type OfficialSourceScope = Readonly<{
  sourceLineage: string;
  game: SupportedGame;
}>;

const scopes: readonly OfficialSourceScope[] = Object.freeze([
  Object.freeze({
    sourceLineage: "one-piece-en",
    game: "one-piece",
  }),
  Object.freeze({
    sourceLineage: "fusion-world-en",
    game: "fusion-world",
  }),
  Object.freeze({
    sourceLineage: "digimon-en",
    game: "digimon",
  }),
  Object.freeze({
    sourceLineage: "gundam-en-asia",
    game: "gundam",
  }),
  Object.freeze({
    sourceLineage: "gundam-en-us",
    game: "gundam",
  }),
]);

export function requiredOfficialSourceScope(sourceLineage: string): OfficialSourceScope {
  const scope = scopes.find((entry) => entry.sourceLineage === sourceLineage);
  if (scope === undefined) {
    throw new AdapterParseFailure("Official Source Lineage has no registered scope.", { category: "configuration" });
  }
  return scope;
}
