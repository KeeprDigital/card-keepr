import { validateCuratedRevision } from "../../src/catalogue/curated";
import { AdministrationProblem, catalogueStore } from "../../src/catalogue/shared";

// A real Workerd/D1 harness for the exported owner validation boundary. It has
// no unsafe-eval binding and performs no production mutation.
export default {
  async fetch(request: Request, env: { CATALOGUE_DB: D1Database }) {
    const body = (await request.json()) as { proposal: unknown; catalogue_revision_id: string };
    try {
      return Response.json(await validateCuratedRevision(catalogueStore(env.CATALOGUE_DB), body.proposal, body.catalogue_revision_id));
    } catch (error) {
      return Response.json({ code: error instanceof AdministrationProblem ? error.code : "unexpected_runtime_failure" }, {status:error instanceof AdministrationProblem ? error.status : 500});
    }
  },
};
