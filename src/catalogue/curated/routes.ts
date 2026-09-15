import type { HttpRoute } from "../../http/openapi";
import { httpRoute, retainedWireValue } from "../../http/openapi";
import { type RouteContext } from "../../http/routes";
import { type CatalogueStore } from "../shared";
import {
  createCuratedRevision,
  listCuratedRevisions,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  supersedeCuratedRevision,
  validateCuratedRevision,
} from "./curated-revisions";
import {
  createCuratedRoute,
  listCuratedRoute,
  reaffirmCuratedRoute,
  retireCuratedRoute,
  showCuratedRoute,
  supersedeCuratedRoute,
  validateCuratedRoute,
  curatedValidationSchema,
  curatedReceiptSchema,
  curatedInspectionSchema,
  curatedListSchema,
} from "./http-contract";

type Environment = { KEEPR_ENVIRONMENT?: string; CATALOGUE_DB: CatalogueStore };
type Context = RouteContext<Environment> & { observedAt: string };
const route = httpRoute<Context>();
const headers = { "Cache-Control": "no-store" };
export const curatedRoutes: HttpRoute<Context>[] = [
  route(validateCuratedRoute, async (c) => {
    const body = c.req.valid("json");
    const original = await c.req.json<typeof body>();
    return c.json(
      curatedValidationSchema.parse(
        await validateCuratedRevision(c.env.env.CATALOGUE_DB, original.proposal, body.catalogue_revision_id),
      ),
      200,
      headers,
    );
  }),
  route(listCuratedRoute, async (c) =>
    c.json(
      retainedWireValue(curatedListSchema, await listCuratedRevisions(c.env.env.CATALOGUE_DB, c.req.valid("query"))),
      200,
      headers,
    ),
  ),
  route(showCuratedRoute, async (c) =>
    c.json(
      retainedWireValue(
        curatedInspectionSchema,
        await showCuratedRevision(c.env.env.CATALOGUE_DB, c.req.valid("param").revision),
      ),
      200,
      headers,
    ),
  ),
  route(createCuratedRoute, async (c) => {
    const _validated = c.req.valid("json");
    // Hono validates the complete envelope. Retain the original JSON for hashing:
    // rebuilding a historical loose object can strip literal __proto__ properties.
    const input = await c.req.json<typeof _validated>();
    const result = await createCuratedRevision(
      c.env.env.CATALOGUE_DB,
      input,
      c.env.observedAt,
      c.env.env.KEEPR_ENVIRONMENT,
    );
    return c.json(curatedReceiptSchema.parse(result.document), result.created ? 201 : 200, headers);
  }),
  route(reaffirmCuratedRoute, async (c) => {
    const _validated = c.req.valid("json");
    const result = await reaffirmCuratedRevision(
      c.env.env.CATALOGUE_DB,
      c.req.valid("param").revision,
      await c.req.json<typeof _validated>(),
      c.env.observedAt,
      c.env.env.KEEPR_ENVIRONMENT,
    );
    return c.json(curatedReceiptSchema.parse(result.document), 200, headers);
  }),
  route(retireCuratedRoute, async (c) => {
    const _validated = c.req.valid("json");
    const result = await retireCuratedRevision(
      c.env.env.CATALOGUE_DB,
      c.req.valid("param").revision,
      await c.req.json<typeof _validated>(),
      c.env.observedAt,
      c.env.env.KEEPR_ENVIRONMENT,
    );
    return c.json(curatedReceiptSchema.parse(result.document), 200, headers);
  }),
  route(supersedeCuratedRoute, async (c) => {
    const _validated = c.req.valid("json");
    const result = await supersedeCuratedRevision(
      c.env.env.CATALOGUE_DB,
      c.req.valid("param").revision,
      await c.req.json<typeof _validated>(),
      c.env.observedAt,
      c.env.env.KEEPR_ENVIRONMENT,
    );
    return c.json(curatedReceiptSchema.parse(result.document), result.created ? 201 : 200, headers);
  }),
];
