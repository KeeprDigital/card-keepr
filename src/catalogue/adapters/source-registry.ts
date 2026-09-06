import { exportedGameProfileSchema, gameProfileForGame, type SupportedGame } from "../shared";

export const publishers = [{ id: "bandai", name: "Bandai" }];
export const sources = [
  ...(["one-piece", "fusion-world", "digimon", "gundam"] as const).map((game) => ({
    id: `bandai-${game}`,
    publisher_id: "bandai",
    name: `Bandai ${game}`,
  })),
  { id: "limitless-one-piece", publisher_id: null, name: "Limitless One Piece" },
];
export type SourceLineageRegistration = Readonly<{
  id: string;
  source_id: string;
  game: SupportedGame;
  locale: "en";
  release_region: "OCEANIA" | "ASIA" | "US";
}>;
export const sourceLineages: readonly SourceLineageRegistration[] = [
  { id: "one-piece-en", source_id: "bandai-one-piece", game: "one-piece", locale: "en", release_region: "OCEANIA" },
  {
    id: "limitless-one-piece-en",
    source_id: "limitless-one-piece",
    game: "one-piece",
    locale: "en",
    release_region: "OCEANIA",
  },
  {
    id: "fusion-world-en",
    source_id: "bandai-fusion-world",
    game: "fusion-world",
    locale: "en",
    release_region: "OCEANIA",
  },
  { id: "digimon-en", source_id: "bandai-digimon", game: "digimon", locale: "en", release_region: "OCEANIA" },
  { id: "gundam-en-asia", source_id: "bandai-gundam", game: "gundam", locale: "en", release_region: "ASIA" },
  { id: "gundam-en-us", source_id: "bandai-gundam", game: "gundam", locale: "en", release_region: "US" },
];

export function gameProfileRegistrations() {
  return (["one-piece", "fusion-world", "digimon", "gundam"] as const).map((game) => {
    const id = gameProfileForGame(game)!;
    return { id, game, publisher_id: "bandai", schema: exportedGameProfileSchema(id) };
  });
}
