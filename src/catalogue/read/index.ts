// Public surface of the `read` cluster: the published-projection responses
// the api worker serves, plus the card-search and source-freshness contracts
// the ingestion side materializes against. See ../README.md (issue #96).

export {
  CardReadProblem,
  CatalogueExportReadProblem,
  PrintingReadProblem,
  catalogueExportComponentResponse,
  catalogueExportResponse,
  catalogueExportsResponse,
  currentCardResponse,
  currentCatalogueStatus,
  currentPrintingResponse,
  printingImageContentResponse,
} from "./read";
export {
  cardCollectionPageQuery,
  cardCollectionResponse,
} from "./card-collection-read";
export {
  PrintingCollectionReadProblem,
  currentPrintingsResponse,
} from "./printing-collection-read";
export {
  ProductReadProblem,
  currentProductResponse,
  currentProductsResponse,
  storedProductApiProjection,
  type StoredProductApiProjection,
} from "./product-release-read";
export {
  LegalityStatusProblem,
  contextualLegalityStatusResponse,
} from "./legality-status";
export {
  cardSearchChunks,
  cardSearchFtsQuery,
  cardSearchQuery,
  cardSearchTerms,
  cardSearchText,
  type CardSearchChunk,
} from "./card-search";
export {
  compareSourceFreshness,
  isCatalogueSourceCheck,
  sourceFreshnessFromStorage,
  sourceFreshnessKey,
  sourceFreshnessStorageScope,
  type SourceFreshnessStorageRow,
} from "./source-freshness";

export { catalogueRoutes } from "./routes";
