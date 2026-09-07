import type { CatalogueCard, CataloguePrinting } from "../shared";

export type CheckedCardScope = {
  sourceLineage: string;
  supportedGame: string;
  cardIdentities: readonly { kind: string; value: string }[];
};

export function checkedPrintingLineages(
  card: CatalogueCard | undefined,
  printing: CataloguePrinting,
  scopes: readonly CheckedCardScope[],
) {
  if (!card) return [];
  return [
    ...new Set(
      scopes
        .filter(
          (scope) =>
            scope.supportedGame === card.game &&
            scope.cardIdentities.some(
              (identity) =>
                identity.kind === card.official_identity.kind && identity.value === card.official_identity.value,
            ) &&
            printing.locator_evidence?.some((evidence) => evidence.source_lineage === scope.sourceLineage),
        )
        .map((scope) => scope.sourceLineage),
    ),
  ].sort();
}
