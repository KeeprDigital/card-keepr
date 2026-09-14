import {
  exportsRoute,
  exportManifestRoute,
  exportComponentRoute,
  exportManifestSchema,
  exportCollectionSchema,
} from "./export-http-contract";
import { httpRoute, streamingHttpRoute } from "../../http/openapi";
import {
  cardsRoute,
  cardCollectionSchema,
  imageRoute,
  gamesRoute,
  gamesSchema,
  catalogueRoute,
  catalogueSchema,
  cardDetailRoute,
  cardDetailSchema,
  printingsRoute,
  printingDetailRoute,
  printingCollectionSchema,
  printingDetailSchema,
  productsRoute,
  productDetailRoute,
  productCollectionSchema,
  productDetailSchema,
} from "./http-contract";
import { canonicalEtag, conditionalResponse, revisionHeaders } from "./collection-endpoint";
import { publicUrl } from "../../http/public-base";
import { publishedGames } from "./game-discovery";
import { ReadProblem } from "./collection-endpoint";
import { compositionExportResponse, compositionExportComponentResponse } from "./composition-export";
import { compositionEntityResponse, compositionImageResponse } from "./composition-read";
import { catalogueResponse } from "../../http/catalogue";
import { type RouteContext } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { cardCollectionResponse } from "./card-collection-read";
import { currentPrintingsResponse } from "./printing-collection-read";
import { currentProductResponse, currentProductsResponse } from "./product-release-read";
import {
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
  httpRoute<Context>()(gamesRoute, async (c) => {
    c.req.valid("query");
    const { env, base, request } = c.env;
    const status = await currentCatalogueStatus(env.CATALOGUE_DB);
    const document = gamesSchema.parse({
      data: await publishedGames(env.CATALOGUE_DB, status.revisionId, base),
      meta: { catalogue_revision_id: status.revisionId, published_at: status.publishedAt },
      links: { self: publicUrl(base, "/v1/games") },
    });
    const headers = revisionHeaders(status.revisionId, await canonicalEtag(document));
    if (conditionalResponse(request, headers)) return c.body(null, 304, headers);
    return c.json(document, 200, headers);
  }),
  httpRoute<Context>()(catalogueRoute, async (c) => {
    c.req.valid("query");
    const { env, base, request } = c.env;
    const response = catalogueResponse(await currentCatalogueStatus(env.CATALOGUE_DB), base, request);
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(catalogueSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(cardsRoute, async (c) => {
    const { env, base } = c.env;
    const query = c.req.valid("query");
    const url = new URL(c.req.url);
    url.search = new URLSearchParams(
      Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ).toString();
    const request = new Request(url, c.req.raw);
    const response = await nativeOrLegacy(
      () =>
        compositionEntityResponse(env.CATALOGUE_DB, request, base, "cards", undefined, (revision) =>
          cardCollectionResponse(env.CATALOGUE_DB, request, base, revision),
        ),
      () => cardCollectionResponse(env.CATALOGUE_DB, request, base),
    );
    if (!response) throw new Error("Card search returned no representation.");
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(cardCollectionSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(cardDetailRoute, async (c) => {
    const { env, request, base } = c.env;
    const { card } = c.req.valid("param");
    c.req.valid("query");
    const response = await nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "cards", card),
      () => currentCardResponse(env.CATALOGUE_DB, card, request, base),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(cardDetailSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(printingsRoute, async (c) => {
    const { env, request, base } = c.env;
    c.req.valid("query");
    const response = await nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "printings"),
      () => currentPrintingsResponse(env.CATALOGUE_DB, request, base),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(printingCollectionSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(printingDetailRoute, async (c) => {
    const { env, request, base } = c.env;
    const { printing } = c.req.valid("param");
    c.req.valid("query");
    const response = await nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "printings", printing),
      () => currentPrintingResponse(env.CATALOGUE_DB, printing, request, base),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(printingDetailSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  ...(["get", "head"] as const).map((method) =>
    streamingHttpRoute<Context>()(imageRoute(method), async (c) => {
      const { env, request } = c.env;
      const { image } = c.req.valid("param");
      return (
        (await nativeOrLegacy(
          () => compositionImageResponse(env.CATALOGUE_DB, env.PRINTING_IMAGES, request, image),
          () => printingImageContentResponse(request, env.CATALOGUE_DB, env.PRINTING_IMAGES, image),
        )) ?? c.notFound()
      );
    }),
  ),
  httpRoute<Context>()(productsRoute, async (c) => {
    const { env, request, base } = c.env;
    c.req.valid("query");
    const response = await nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "products"),
      () => currentProductsResponse(env.CATALOGUE_DB, request, base),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(productCollectionSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(productDetailRoute, async (c) => {
    const { env, request, base } = c.env;
    const { product } = c.req.valid("param");
    c.req.valid("query");
    const response = await nativeOrLegacy(
      () => compositionEntityResponse(env.CATALOGUE_DB, request, base, "products", product),
      () => currentProductResponse(env.CATALOGUE_DB, product, request, base),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(productDetailSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  ...(["get", "head"] as const).map((method) =>
    streamingHttpRoute<Context>()(exportComponentRoute(method), async (c) => {
      const { env, request } = c.env;
      const { revision, component } = c.req.valid("param");
      c.req.valid("query");
      return (
        (await currentExport(() =>
          compositionExportComponentResponse(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, request, revision, component),
        )) ?? c.notFound()
      );
    }),
  ),
  httpRoute<Context>()(exportsRoute, async (c) => {
    const { env, request, base } = c.env;
    c.req.valid("query");
    const response = await catalogueExportsResponse(request, env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, base);
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(exportCollectionSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
  httpRoute<Context>()(exportManifestRoute, async (c) => {
    const { env, request, base } = c.env;
    const { revision } = c.req.valid("param");
    c.req.valid("query");
    const response = await currentExport(() =>
      compositionExportResponse(env.CATALOGUE_DB, request, base, revision, env.CATALOGUE_EXPORTS),
    );
    if (!response) return c.notFound();
    if (response.status === 304) return c.body(null, 304, Object.fromEntries(response.headers));
    return c.json(exportManifestSchema.parse(await response.json()), 200, Object.fromEntries(response.headers));
  }),
];

async function nativeOrLegacy(
  native: () => Promise<Response | null | undefined>,
  legacy: () => Promise<Response | null>,
) {
  const response = await native();
  return response === undefined ? legacy() : response;
}

async function currentExport(read: () => Promise<Response | null | undefined>) {
  const response = await read();
  if (response === undefined)
    throw new ReadProblem(
      503,
      "catalogue_export_unavailable",
      "This revision has no current public export. Use a native publication from the supported baseline.",
    );
  return response;
}
