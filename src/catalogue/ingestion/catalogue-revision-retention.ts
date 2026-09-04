import type { CatalogueStore } from "../shared";
import {
  type CatalogueRevisionTargetRow,
  type CatalogueRevisionWindowRow,
  repairableCatalogueRevisionTargetStatement,
  repairableCatalogueRevisionWindowStatement,
} from "./catalogue-revision-repository";

export function repairableCatalogueRevisionWindow(
  database: CatalogueStore,
): Promise<D1Result<CatalogueRevisionWindowRow>> {
  return repairableCatalogueRevisionWindowStatement(database).all<CatalogueRevisionWindowRow>();
}

export function repairableCatalogueRevisionTarget(
  database: CatalogueStore,
  targetRevisionId: string,
): Promise<CatalogueRevisionTargetRow | null> {
  return repairableCatalogueRevisionTargetStatement(database, targetRevisionId).first<CatalogueRevisionTargetRow>();
}
