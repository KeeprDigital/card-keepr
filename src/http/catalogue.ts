type CatalogueStatus = {
  revisionId: string;
  publishedAt: string;
};

export function catalogueResponse(status: CatalogueStatus): Response {
  const currentExport = `/v1/catalogue-exports/${status.revisionId}`;
  return Response.json(
    {
      data: {
        type: "catalogue",
        current_revision_id: status.revisionId,
        published_at: status.publishedAt,
        last_successful_checks: [],
        current_export: currentExport,
      },
      meta: {
        catalogue_revision_id: status.revisionId,
        published_at: status.publishedAt,
      },
      links: {
        self: "/v1/catalogue",
        cards: "/v1/cards",
        printings: "/v1/printings",
        products: "/v1/products",
        catalogue_exports: "/v1/catalogue-exports",
      },
    },
    {
      headers: {
        "cache-control": "private, no-cache",
        etag: `"${status.revisionId}"`,
        "x-catalogue-revision": status.revisionId,
      },
    },
  );
}
