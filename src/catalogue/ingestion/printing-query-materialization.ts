import { byteBoundedJsonArrays, type CatalogueStore, type SupportedGame } from "../shared";
import {
  publishPrintingProductQueryFactsStatement,
  publishPrintingQueryFactsStatement,
} from "./printing-query-repository";

export type PrintingQueryFact = {
  printing_id: string;
  card_id: string;
  supported_game: SupportedGame;
  normalized_rarity: string | null;
};

/** One publication step owns Printing filters and the Printing-derived facts #52 consumes. */
export function printingQueryProjectionStatements(
  database: CatalogueStore,
  revisionId: string,
  printings: readonly PrintingQueryFact[],
): D1PreparedStatement[] {
  return [
    ...byteBoundedJsonArrays(printings).map((chunk) =>
      publishPrintingQueryFactsStatement(database, { revisionId: revisionId, factsJson: chunk }),
    ),
    // Match the published relationship lifecycle and Product's published regions,
    // including a Product with no regions. No source/reconciliation table is read.
    publishPrintingProductQueryFactsStatement(database, revisionId),
  ];
}
