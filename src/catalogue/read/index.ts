// Public surface of the `read` cluster: the published-projection responses
// the api worker serves, plus the card-search and source-freshness contracts
// the ingestion side materializes against. See ../README.md (issue #96).

export { cardCollectionResponse } from "./card-collection-read";
export { cardCollectionPageQuery } from "./card-collection-repository";
export {
  type CardSearchChunk,
  cardSearchChunks,
  cardSearchFtsQuery,
  cardSearchQuery,
  cardSearchText,
} from "./card-search";
export { ReadProblem } from "./collection-endpoint";
export { currentPrintingsResponse } from "./printing-collection-read";
export { type PrintingCollectionFilters, printingCollectionQuery } from "./printing-collection-repository";
export {
  currentProductResponse,
  currentProductsResponse,
  type StoredProductApiProjection,
  storedProductApiProjection,
} from "./product-release-read";
export {
  catalogueExportComponentResponse,
  catalogueExportResponse,
  catalogueExportsResponse,
  currentCardResponse,
  currentCatalogueStatus,
  currentPrintingResponse,
  printingImageContentResponse,
} from "./read";
export { catalogueRoutes } from "./routes";
export {
  compareSourceFreshness,
  isCatalogueSourceCheck,
  type SourceFreshnessStorageRow,
  sourceFreshnessFromStorage,
  sourceFreshnessKey,
  sourceFreshnessStorageScope,
} from "./source-freshness";

export { compositionEntityResponse, compositionImageResponse } from "./composition-read";
export { composedDocumentStatement } from "./composition-read-repository";

export { composedPublicRecord, type DocumentRow } from "./composition-read";
export {
  publicationExportSourceStatement,
  publicationExportDependenciesStatement,
} from "./composition-read-repository";
