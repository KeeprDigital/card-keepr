import type { CatalogueStore } from "../shared";
import { ReadProblem } from "./collection-endpoint";
import { compositionCursor, emptyCompositionFilters, hydrate, type DocumentRow } from "./composition-read";
import { composedCollectionStatement, nativeRevisionStatement } from "./composition-read-repository";

/** Bounded candidates from the same immutable projections and order consumed by public reads. */
export async function compositionSmokeTargets(
  database: CatalogueStore,
  revisionId: string,
  searchQueryFor: (document: string) => string | null,
  requireImage: boolean,
): Promise<Record<string, string> | null | undefined> {
  const revision = await nativeRevisionStatement(database, revisionId, false).first<{
    query_state: string;
    search_state: string;
  }>();
  if (revision === null) return undefined;
  if (revision.query_state !== "available" || revision.search_state !== "ready") return null;
  try {
    const [cards, printings, images] = await Promise.all(
      ["cards", "printings", ...(requireImage ? ["printing_images"] : [])].map(
        async (kind) =>
          (
            await composedCollectionStatement(
              database,
              revisionId,
              kind,
              "",
              2,
              emptyCompositionFilters,
            ).all<DocumentRow>()
          ).results,
      ),
    );
    if (cards!.length !== 2 || printings!.length !== 2 || (requireImage && images!.length === 0)) return null;
    const card = await hydrate(database, cards![1]!);
    const printing = await hydrate(database, printings![1]!);
    const image = requireImage ? await hydrate(database, images![0]!) : null;
    const query = searchQueryFor(JSON.stringify(card));
    if (
      query === null ||
      typeof card.id !== "string" ||
      typeof printing.id !== "string" ||
      (requireImage && typeof image?.id !== "string")
    )
      return null;
    const searchFilters = { ...emptyCompositionFilters, q: query };
    const matches = (
      await composedCollectionStatement(
        database,
        revisionId,
        "cards",
        cards![0]!.position!,
        50,
        searchFilters,
      ).all<DocumentRow>()
    ).results;
    if (!matches.some((row) => row.entity_id === card.id)) return null;
    return {
      revision_id: revisionId,
      card_id: card.id,
      printing_id: printing.id,
      ...(image === null ? {} : { printing_image_id: String(image.id) }),
      search_query: query,
      card_cursor: compositionCursor(revisionId, "cards", emptyCompositionFilters, cards![0]!.position!, 50),
      search_cursor: compositionCursor(revisionId, "cards", searchFilters, cards![0]!.position!, 50),
      printing_cursor: compositionCursor(
        revisionId,
        "printings",
        emptyCompositionFilters,
        printings![0]!.position!,
        50,
      ),
    };
  } catch (error) {
    if (error instanceof ReadProblem) return null;
    throw error;
  }
}
