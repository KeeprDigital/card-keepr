import { exportedGameProfileSchema, registeredGameProfiles, type SupportedGame } from "../shared";

export const publishers = [
  { id: "bandai", name: "Bandai" },
  { id: "riot-games", name: "Riot Games" },
  { id: "wizards-of-the-coast", name: "Wizards of the Coast" },
  { id: "pokemon-company-international", name: "The Pokémon Company International" },
];
export const sources = [
  { id: "tcgdex-pokemon", publisher_id: null, name: "TCGdex Pokémon" },
  {
    id: "pokemon-official",
    publisher_id: "pokemon-company-international",
    name: "Selected official Pokémon publications",
  },
  { id: "riot-riftbound", publisher_id: "riot-games", name: "Riot Riftbound" },
  { id: "riftbound-db", publisher_id: null, name: "Riftbound DB" },
  ...(["one-piece", "fusion-world", "digimon", "gundam"] as const).map((game) => ({
    id: `bandai-${game}`,
    publisher_id: "bandai",
    name: `Bandai ${game}`,
  })),
  { id: "limitless-one-piece", publisher_id: null, name: "Limitless One Piece" },
  { id: "scryfall", publisher_id: null, name: "Scryfall" },
];
export type SourceLineageRegistration = Readonly<{
  id: string;
  source_id: string;
  game: SupportedGame;
  locale: "en";
  release_region: "OCEANIA" | "ASIA" | "US" | "unknown";
}>;
export const sourceLineages: readonly SourceLineageRegistration[] = [
  { id: "tcgdex-pokemon-en", source_id: "tcgdex-pokemon", game: "pokemon", locale: "en", release_region: "unknown" },
  {
    id: "pokemon-official-en",
    source_id: "pokemon-official",
    game: "pokemon",
    locale: "en",
    release_region: "unknown",
  },
  { id: "scryfall-magic-en", source_id: "scryfall", game: "magic", locale: "en", release_region: "unknown" },
  { id: "riftbound-en", source_id: "riot-riftbound", game: "riftbound", locale: "en", release_region: "US" },
  { id: "riftbound-db-en", source_id: "riftbound-db", game: "riftbound", locale: "en", release_region: "unknown" },
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
  return registeredGameProfiles().map(({ id, game }) => {
    return {
      id,
      game,
      publisher_id:
        game === "pokemon"
          ? "pokemon-company-international"
          : game === "magic"
            ? "wizards-of-the-coast"
            : game === "riftbound"
              ? "riot-games"
              : "bandai",
      schema: exportedGameProfileSchema(id),
    };
  });
}
