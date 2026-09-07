import { compositionExportResponse, compositionExportComponentResponse } from "./composition-export";
import { compositionEntityResponse, compositionImageResponse } from "./composition-read";
import { catalogueResponse } from "../../http/catalogue";
import { type RouteContext, route } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { cardCollectionResponse } from "./card-collection-read";
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
    nativeOrLegacy(
      () =>
        compositionEntityResponse(env.CATALOGUE_DB, request, base, "cards", undefined, (revision) =>
          cardCollectionResponse(env.CATALOGUE_DB, request, base, revision),
        ),
      () => cardCollectionResponse(env.CATALOGUE_DB, request, base),
    ),
  ),
  route<Context>("GET", "/v1/cards/:card", async ({ env, request, base }, params) =>
    nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "cards", params.card!),
      () => currentCardResponse(env.CATALOGUE_DB, params.card!, request, base),
    ),
  ),
  route<Context>("GET", "/v1/printings", async ({ env, request, base }) =>
    nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "printings"),
      () => currentPrintingsResponse(env.CATALOGUE_DB, request, base),
    ),
  ),
  route<Context>("GET", "/v1/printings/:printing", async ({ env, request, base }, params) =>
    nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "printings", params.printing!),
      () => currentPrintingResponse(env.CATALOGUE_DB, params.printing!, request, base),
    ),
  ),
  ...["GET", "HEAD"].map((method) =>
    route<Context>(method, "/v1/printing-images/:image/content", async ({ env, request }, params) =>
      nativeOrLegacy(
        () => compositionImageResponse(env.CATALOGUE_DB, env.PRINTING_IMAGES, request, params.image!),
        () => printingImageContentResponse(request, env.CATALOGUE_DB, env.PRINTING_IMAGES, params.image!),
      ),
    ),
  ),
  route<Context>("GET", "/v1/products", async ({ env, request, base }) =>
    nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "products"),
      () => currentProductsResponse(env.CATALOGUE_DB, request, base),
    ),
  ),
  route<Context>("GET", "/v1/products/:product", async ({ env, request, base }, params) =>
    nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "products", params.product!),
      () => currentProductResponse(env.CATALOGUE_DB, params.product!, request, base),
    ),
  ),
  ...["GET", "HEAD"].map((method) =>
    route<Context>(method, "/v1/catalogue-exports/:revision/components/:component", async ({ env, request }, params) =>
      nativeOrLegacy(
        () =>
          compositionExportComponentResponse(
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            request,
            params.revision!,
            params.component!,
          ),
        () =>
          catalogueExportComponentResponse(
            request,
            env.CATALOGUE_DB,
            env.CATALOGUE_EXPORTS,
            params.revision!,
            params.component!,
          ),
      ),
    ),
  ),
  route<Context>("GET", "/v1/catalogue-exports", async ({ env, request, base }) =>
    catalogueExportsResponse(request, env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, base),
  ),
  route<Context>("GET", "/v1/catalogue-exports/:revision", async ({ env, request, base }, params) =>
    nativeOrLegacy(
      () => compositionExportResponse(env.CATALOGUE_DB, request, base, params.revision!),
      () => catalogueExportResponse(request, env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, params.revision!, base),
    ),
  ),
];

async function nativeOrLegacy(
  native: () => Promise<Response | null | undefined>,
  legacy: () => Promise<Response | null>,
) {
  const response = await native();
  return response === undefined ? legacy() : response;
}
