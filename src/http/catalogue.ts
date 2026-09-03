import { ifNoneMatch } from "./conditional";
import { publicUrl, type PublicBase } from "./public-base";

declare const catalogueRevisionIdBrand: unique symbol;
declare const publicationInstantBrand: unique symbol;

export type CatalogueRevisionId = string & {
  readonly [catalogueRevisionIdBrand]: true;
};

export type PublicationInstant = string & {
  readonly [publicationInstantBrand]: true;
};

type CatalogueStatus = {
  revisionId: CatalogueRevisionId;
  publishedAt: PublicationInstant;
  lastSuccessfulChecks: readonly {
    game: "one-piece" | "fusion-world" | "digimon" | "gundam";
    area:
      | "cards-and-printings"
      | "products-and-releases"
      | "legality-rules"
      | "errata";
    checked_at: PublicationInstant;
  }[];
  etag: string;
};

export function parseCatalogueRevisionId(value: string): CatalogueRevisionId {
  if (
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error("Catalogue Revision ID configuration is invalid");
  }
  return value as CatalogueRevisionId;
}

export function parsePublicationInstant(value: string): PublicationInstant {
  if (!value.endsWith("Z") || Number.isNaN(Date.parse(value))) {
    throw new Error("Catalogue publication time configuration is invalid");
  }
  return value as PublicationInstant;
}

export function catalogueResponse(
  status: CatalogueStatus,
  base: PublicBase,
  request?: Request,
): Response {
  const currentExport = publicUrl(
    base,
    `/v1/catalogue-exports/${status.revisionId}`,
  );
  const headers = {
    "cache-control": "private, no-cache",
    etag: `"${status.etag}"`,
    "x-catalogue-revision": status.revisionId,
  };
  if (request !== undefined && ifNoneMatch(request, headers.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return Response.json(
    {
      data: {
        type: "catalogue",
        current_revision_id: status.revisionId,
        published_at: status.publishedAt,
        last_successful_checks: status.lastSuccessfulChecks,
        current_export: currentExport,
      },
      meta: {
        catalogue_revision_id: status.revisionId,
        published_at: status.publishedAt,
      },
      links: {
        self: publicUrl(base, "/v1/catalogue"),
        cards: publicUrl(base, "/v1/cards"),
        printings: publicUrl(base, "/v1/printings"),
        products: publicUrl(base, "/v1/products"),
        catalogue_exports: publicUrl(base, "/v1/catalogue-exports"),
      },
    },
    {
      headers,
    },
  );
}
