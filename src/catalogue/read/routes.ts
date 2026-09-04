import { catalogueResponse } from "../../http/catalogue";
import { type RouteContext, route } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { cardCollectionResponse } from "./card-collection-read";
import { contextualLegalityStatusResponse } from "./legality-status";
import { currentPrintingsResponse } from "./printing-collection-read";
import { currentProductResponse, currentProductsResponse } from "./product-release-read";
import {
  catalogueExportComponentResponse,
  catalogueExportResponse,
  catalogueExportsResponse,
  currentCardResponse,
  currentCatalogueStatus,
  currentPrintingResponse,
  printingImageContentResponse,
} from "./read";

type Context = RouteContext<{
  CATALOGUE_DB: CatalogueStore;
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
}>;

export const catalogueRoutes = [
  route<Context>("GET", "/v1/catalogue", async ({ env, base, request }) =>
    catalogueResponse(await currentCatalogueStatus(env.CATALOGUE_DB), base, request),
  ),
  route<Context>("GET", "/v1/cards", async ({ env, request, base }) =>
    cardCollectionResponse(env.CATALOGUE_DB, request, base),
  ),
  route<Context>("GET", "/v1/cards/:card", async ({ env, request, base }, params) =>
    currentCardResponse(env.CATALOGUE_DB, params.card!, request, base),
  ),
  route<Context>("GET", "/v1/legality-status", async ({ env, request, base }) =>
    contextualLegalityStatusResponse(request, env.CATALOGUE_DB, base),
  ),
  route<Context>("GET", "/v1/printings", async ({ env, request, base }) =>
    currentPrintingsResponse(env.CATALOGUE_DB, request, base),
  ),
  route<Context>("GET", "/v1/printings/:printing", async ({ env, request, base }, params) =>
    currentPrintingResponse(env.CATALOGUE_DB, params.printing!, request, base),
  ),
  ...["GET", "HEAD"].map((method) =>
    route<Context>(method, "/v1/printing-images/:image/content", async ({ env, request }, params) =>
      printingImageContentResponse(request, env.CATALOGUE_DB, env.PRINTING_IMAGES, params.image!),
    ),
  ),
  route<Context>("GET", "/v1/products", async ({ env, request, base }) =>
    currentProductsResponse(env.CATALOGUE_DB, request, base),
  ),
  route<Context>("GET", "/v1/products/:product", async ({ env, request, base }, params) =>
    currentProductResponse(env.CATALOGUE_DB, params.product!, request, base),
  ),
  ...["GET", "HEAD"].map((method) =>
    route<Context>(method, "/v1/catalogue-exports/:revision/components/:component", async ({ env, request }, params) =>
      catalogueExportComponentResponse(
        request,
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        params.revision!,
        params.component!,
      ),
    ),
  ),
  route<Context>("GET", "/v1/catalogue-exports", async ({ env, request, base }) =>
    catalogueExportsResponse(request, env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, base),
  ),
  route<Context>("GET", "/v1/catalogue-exports/:revision", async ({ env, request, base }, params) =>
    catalogueExportResponse(request, env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, params.revision!, base),
  ),
];
