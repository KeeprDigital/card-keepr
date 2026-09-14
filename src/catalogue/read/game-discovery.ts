import { publicUrl, type PublicBase } from "../../http/public-base";
import { type CatalogueStore, requiredProfileContract } from "../shared";
import { ReadProblem } from "./collection-endpoint";
import {
  composedDocumentStatement,
  composedSupportedGamesStatement,
  nativeRevisionStatement,
} from "./composition-read-repository";
import { hydrate, type DocumentRow } from "./composition-read";
import { cardQuerySchema, printingQuerySchema, productQuerySchema, profileFields } from "./http-contract";

/** Discovery reads the same immutable, published membership as consumer records. */
export async function publishedGames(database: CatalogueStore, revisionId: string, base: PublicBase) {
  const revision = await nativeRevisionStatement(database, revisionId, false, false).first<{
    model_ready: number;
    query_state: string;
  }>();
  if (revision && (revision.model_ready !== 1 || revision.query_state !== "available"))
    throw new ReadProblem(
      503,
      "catalogue_query_unavailable",
      "The published Game Profiles require available current-model projections.",
    );
  const games = (await composedSupportedGamesStatement(database, revisionId).all<{ supported_game: string }>()).results;
  const data = [];
  for (const { supported_game: game } of games) {
    const row = await composedDocumentStatement(
      database,
      revisionId,
      "supported_games",
      `game_${game.replaceAll("-", "_")}`,
    ).first<DocumentRow>();
    if (!row) throw new ReadProblem(503, "catalogue_query_unavailable", "The published Supported Game is unavailable.");
    const value = await hydrate(database, row);
    const profile = String(value.game_profile);
    const contract = requiredProfileContract(profile);
    if (contract.game !== game)
      throw new ReadProblem(503, "catalogue_query_unavailable", "The published Game Profile binding is invalid.");
    const cardFields = profileFields(contract.card);
    data.push({
      type: "supported_game",
      id: value.id,
      key: value.key,
      name: value.name,
      supported_locales: value.supported_locales,
      game_profile: { id: profile, card_fields: cardFields, printing_fields: profileFields(contract.printing) },
      filters: {
        cards: Object.keys(cardQuerySchema.shape)
          .filter((name) => !name.startsWith("attribute."))
          .concat(cardFields.map(({ path }) => `attribute.${path}`)),
        printings: Object.keys(printingQuerySchema.shape),
        products: Object.keys(productQuerySchema.shape),
      },
      links: Object.fromEntries(
        ["cards", "printings", "products"].map((kind) => [
          kind,
          publicUrl(base, `/v1/${kind}?game=${game}&revision=${revisionId}`),
        ]),
      ),
    });
  }
  return data;
}
