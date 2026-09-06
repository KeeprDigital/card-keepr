import { inspectProposalSourceEvidence } from "./entity-admission";
import {
  listEntityProposals,
  createEntityProposal,
  inspectEntityProposal,
  decideEntityProposal,
} from "./entity-admission";
import { inspectCanonicalIdentity, inspectIdentityReviews, resolveIdentityReview } from "./canonical-identity";
import { assertOnlyFields, readAdministrationBody, requiredString } from "../../http/administration";
import { type RouteContext, route } from "../../http/routes";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { showReconciledPrinting } from "./card-printing-reconciliation";
import { startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes = [
  route<Context>("GET", "/v1/entity-proposals", async ({ request, env }) => {
    const query = new URL(request.url).searchParams;
    return Response.json(
      await listEntityProposals(env.CATALOGUE_DB, query.get("game") ?? "", query.get("after") ?? ""),
    );
  }),
  route<Context>("POST", "/v1/entity-proposals", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["game", "source_lineage", "reference", "content", "evidence", "idempotency_key"]);
    return Response.json(
      await createEntityProposal(
        env.CATALOGUE_DB,
        {
          game: requiredString(body, "game"),
          source_lineage: requiredString(body, "source_lineage"),
          reference: requiredString(body, "reference"),
          content: body.content,
          evidence: body.evidence,
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      ),
      { status: 201 },
    );
  }),
  route<Context>("GET", "/v1/entity-proposals/:proposal", async ({ env, request }, params) => {
    const after = new URL(request.url).searchParams.get("after_generation") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after)))
      throw new AdministrationProblem(422, "admission_cursor_invalid", "Use a non-negative history generation.");
    return Response.json(await inspectEntityProposal(env.CATALOGUE_DB, params.proposal!, Number(after)));
  }),
  route<Context>("GET", "/v1/entity-proposals/:proposal/evidence", async ({ env, request }, params) =>
    Response.json(
      await inspectProposalSourceEvidence(
        env.CATALOGUE_DB,
        params.proposal!,
        new URL(request.url).searchParams.get("after") ?? "",
      ),
    ),
  ),
  route<Context>("POST", "/v1/entity-proposals/:proposal/decisions", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "action",
      "expected_generation",
      "rationale",
      "idempotency_key",
      "exception",
      "card_id",
      "printing_id",
    ]);
    return Response.json(
      await decideEntityProposal(
        env.CATALOGUE_DB,
        params.proposal!,
        {
          ...(body.exception === undefined ? {} : { exception: body.exception }),
          ...(body.card_id === undefined ? {} : { card_id: requiredString(body, "card_id") }),
          ...(body.printing_id === undefined ? {} : { printing_id: requiredString(body, "printing_id") }),
          action: requiredString(body, "action"),
          expected_generation: requiredString(body, "expected_generation"),
          rationale: requiredString(body, "rationale"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      ),
    );
  }),
  route<Context>("GET", "/v1/reconciliation/identity-reviews", async ({ request, env }) => {
    const query = new URL(request.url).searchParams;
    return Response.json(
      await inspectIdentityReviews(env.CATALOGUE_DB, query.get("run_id") ?? "", query.get("after") ?? ""),
    );
  }),
  route<Context>(
    "POST",
    "/v1/reconciliation/identity-reviews/:review/resolve",
    async ({ request, env, observedAt }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["printing_id", "rationale", "idempotency_key"]);
      return Response.json(
        await resolveIdentityReview(
          env.CATALOGUE_DB,
          params.review!,
          {
            printing_id: requiredString(body, "printing_id"),
            rationale: requiredString(body, "rationale"),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        ),
      );
    },
  ),
  route<Context>("GET", "/v1/reconciliation/identities/:identity", async ({ env, request }, params) => {
    return Response.json(
      await inspectCanonicalIdentity(
        env.CATALOGUE_DB,
        params.identity!,
        new URL(request.url).searchParams.get("after") ?? "",
      ),
    );
  }),
  route<Context>("POST", "/v1/ingestion-runs/:run/reconciliation", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["expected_current_revision_id", "idempotency_key"]);
    const result = await startOrObserveReconciliationWorkflow(
      env.CATALOGUE_DB,
      env.RECONCILIATION_WORKFLOW,
      {
        ingestion_run_id: params.run!,
        expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(result.document, {
      status: result.created && result.document.status !== "complete" ? 202 : 200,
    });
  }),
  route<Context>("GET", "/v1/reconciliation/printings/:printing", async ({ env }, params) => {
    return Response.json(await showReconciledPrinting(env.CATALOGUE_DB, params.printing!));
  }),
];
