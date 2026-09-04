// Public surface of the `read` cluster: the published-projection responses
// the api worker serves, plus the card-search and source-freshness contracts
// the ingestion side materializes against. See ../README.md (issue #96).

export {
  cardCollectionPageQuery,
  cardCollectionResponse,
} from "./card-collection-read";
export {
  type CardSearchChunk,
  cardSearchChunks,
  cardSearchFtsQuery,
  cardSearchQuery,
  cardSearchTerms,
  cardSearchText,
} from "./card-search";
export { ReadProblem } from "./collection-endpoint";
export { contextualLegalityStatusResponse } from "./legality-status";
export { type PrintingCollectionFilters, printingCollectionQuery } from "./printing-collection-query";
export { currentPrintingsResponse } from "./printing-collection-read";
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
