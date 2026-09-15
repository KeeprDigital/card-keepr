import { httpRoute } from "../../http/openapi";
import { type Route, type RouteContext } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import {
  catalogueExportDeletionStatus,
  confirmCatalogueExportDeletion,
  prepareCatalogueExportDeletion,
  retryCatalogueExportDeletion,
} from "./catalogue-export-deletion";
import {
  exportDeletionPlanSchema,
  exportDeletionSchema,
  exportDeletionPendingSchema,
  exportDeletionTerminalSchema,
  planExportDeletionRoute,
  confirmExportDeletionRoute,
  retryExportDeletionRoute,
  inspectExportDeletionRoute,
} from "./http-contract";

type Context = RouteContext<{ CATALOGUE_DB: CatalogueStore; CATALOGUE_EXPORTS: R2Bucket }> & { observedAt: string };
const route = httpRoute<Context>();
const headers = { "Cache-Control": "no-store" };
export const exportRoutes: Route<Context>[] = [
  route(planExportDeletionRoute, async (c) =>
    c.json(
      exportDeletionPlanSchema.parse(
        await prepareCatalogueExportDeletion(
          c.env.env.CATALOGUE_DB,
          c.env.env.CATALOGUE_EXPORTS,
          c.req.valid("json"),
          c.env.observedAt,
        ),
      ),
      201,
      headers,
    ),
  ),
  route(confirmExportDeletionRoute, async (c) => {
    const result = await confirmCatalogueExportDeletion(
      c.env.env.CATALOGUE_DB,
      c.env.env.CATALOGUE_EXPORTS,
      c.req.valid("json"),
      c.env.observedAt,
    );
    return result.state === "deleting"
      ? c.json(exportDeletionPendingSchema.parse(result), 202, headers)
      : c.json(exportDeletionTerminalSchema.parse(result), 200, headers);
  }),
  route(retryExportDeletionRoute, async (c) => {
    const result = await retryCatalogueExportDeletion(
      c.env.env.CATALOGUE_DB,
      c.env.env.CATALOGUE_EXPORTS,
      c.req.valid("param").deletion,
      c.req.valid("json"),
      c.env.observedAt,
    );
    return result.state === "deleting"
      ? c.json(exportDeletionPendingSchema.parse(result), 202, headers)
      : c.json(exportDeletionTerminalSchema.parse(result), 200, headers);
  }),
  route(inspectExportDeletionRoute, async (c) =>
    c.json(
      exportDeletionSchema.parse(
        await catalogueExportDeletionStatus(c.env.env.CATALOGUE_DB, c.req.valid("param").deletion),
      ),
      200,
      headers,
    ),
  ),
];
