import {
  type CatalogueRevisionWindowRow,
  type CatalogueRevisionTargetRow,
  repairableCatalogueRevisionWindowStatement,
  repairableCatalogueRevisionTargetStatement,
} from "./catalogue-revision-repository";

export function repairableCatalogueRevisionWindow(database: D1Database): Promise<D1Result<CatalogueRevisionWindowRow>> {
  return repairableCatalogueRevisionWindowStatement(database).all<CatalogueRevisionWindowRow>();
}

export function repairableCatalogueRevisionTarget(
  database: D1Database,
  targetRevisionId: string,
): Promise<CatalogueRevisionTargetRow | null> {
  return repairableCatalogueRevisionTargetStatement(database, targetRevisionId).first<CatalogueRevisionTargetRow>();
}
