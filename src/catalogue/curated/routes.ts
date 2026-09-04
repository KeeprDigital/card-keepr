import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import {
  createCuratedRevision,
  listCuratedRevisions,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  supersedeCuratedRevision,
  validateCuratedRevision,
} from "./curated-revisions";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const curatedRoutes = [
  route<Context>("POST", "/admin/v1/curated-revisions/validate", async ({ request, env }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["proposal", "catalogue_revision_id"]);
    return Response.json(
      await validateCuratedRevision(env.CATALOGUE_DB, body.proposal, requiredString(body, "catalogue_revision_id")),
    );
  }),
  route<Context>("GET", "/admin/v1/curated-revisions", async ({ env, request }) => {
    const url = new URL(request.url);
    const unexpected = [...url.searchParams.keys()].find(
      (parameter) => !["game", "target", "status"].includes(parameter),
    );
    if (unexpected !== undefined) {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        `${unexpected} is not accepted for this administration operation.`,
      );
    }
    return Response.json(
      await listCuratedRevisions(env.CATALOGUE_DB, {
        ...(url.searchParams.has("game") ? { game: url.searchParams.get("game")! } : {}),
        ...(url.searchParams.has("target") ? { target: url.searchParams.get("target")! } : {}),
        ...(url.searchParams.has("status") ? { status: url.searchParams.get("status")! } : {}),
      }),
    );
  }),
  route<Context>("POST", "/admin/v1/curated-revisions", async ({ request, env, observedAt }) => {
    const result = await createCuratedRevision(env.CATALOGUE_DB, await readAdministrationBody(request), observedAt);
    return Response.json(result.document, {
      status: result.created ? 201 : 200,
    });
  }),
  ...["reaffirm", "supersede", "retire"].map((operation) =>
    route<Context>(
      "POST",
      `/admin/v1/curated-revisions/:revision/${operation}`,
      async ({ request, env, observedAt }, params) => {
        const revisionId = params.revision!;
        const body = await readAdministrationBody(request);
        const result =
          operation === "reaffirm"
            ? await reaffirmCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt)
            : operation === "supersede"
              ? await supersedeCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt)
              : await retireCuratedRevision(env.CATALOGUE_DB, revisionId, body, observedAt);
        return Response.json(result.document, {
          status: result.created && operation === "supersede" ? 201 : 200,
        });
      },
    ),
  ),
  route<Context>("GET", "/admin/v1/curated-revisions/:revision", async ({ env }, params) => {
    return Response.json(await showCuratedRevision(env.CATALOGUE_DB, params.revision!));
  }),
];
