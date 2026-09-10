import { isCatalogueSourceCheck } from "../read";
import type { CatalogueStore } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";

/** One immutable receipt of at most three checked surfaces; never consumer content. */
export async function retainNativeSourceChecks(db: CatalogueStore, preparationId: string, checks: unknown) {
  const values = checks ?? [];
  if (
    !Array.isArray(values) ||
    values.length > 3 ||
    values.some((value) => !isCatalogueSourceCheck(value)) ||
    new Set(values.map((value) => `${value.game}:${value.area}`)).size !== values.length
  ) {
    throw new Error("Native source freshness evidence is invalid.");
  }
  await new ReconciliationReducerIndex(db, preparationId, "publication_source_checks").seed("checks", {
    checks: values,
  });
}
