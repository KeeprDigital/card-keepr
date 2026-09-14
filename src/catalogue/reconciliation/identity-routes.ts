import { httpRoute } from "../../http/openapi";
import type { RouteContext } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { inspectCanonicalIdentity, inspectIdentityReviews, resolveIdentityReview } from "./canonical-identity";
import { showReconciledPrinting } from "./card-printing-reconciliation";
import {
  inspectIdentityRoute,
  listIdentityReviewsRoute,
  resolveIdentityRoute,
  inspectReconciledPrintingRoute,
  identityInspectionSchema,
  identityReviewsSchema,
  identityDecisionSchema,
  reconciledPrintingSchema,
} from "./identity-review-http-contract";
import {
  validateIdentityCorrection,
  createIdentityCorrection,
  inspectIdentityCorrection,
  listIdentityCorrections,
} from "./identity-corrections";
import {
  validateCorrectionRoute,
  createCorrectionRoute,
  inspectCorrectionRoute,
  listCorrectionsRoute,
  correctionValidationSchema,
  correctionInspectionSchema,
  correctionsSchema,
} from "./identity-correction-http-contract";
import {
  createEntityProposal,
  inspectEntityProposal,
  decideEntityProposal,
  listEntityProposals,
  inspectProposalSourceEvidence,
} from "./entity-admission";
import {
  createEntityProposalRoute,
  inspectEntityProposalRoute,
  decideEntityProposalRoute,
  entityProposalSchema,
  listEntityProposalsRoute,
  entityProposalsSchema,
  proposalEvidenceRoute,
  proposalEvidenceSchema,
} from "./entity-admission-http-contract";

type Context = RouteContext<{ CATALOGUE_DB: CatalogueStore }> & { observedAt: string };
const headers = { "Cache-Control": "no-store" };
export const identityRoutes = [
  httpRoute<Context>()(inspectIdentityRoute, async (c) =>
    c.json(
      identityInspectionSchema.parse(
        await inspectCanonicalIdentity(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").identity,
          c.req.valid("query").after ?? "",
          c.req.valid("query").preparation_id ?? null,
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(listIdentityReviewsRoute, async (c) =>
    c.json(
      identityReviewsSchema.parse(
        await inspectIdentityReviews(
          c.env.env.CATALOGUE_DB,
          c.req.valid("query").run_id ?? "",
          c.req.valid("query").after ?? "",
          c.req.valid("query").preparation_id ?? null,
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(resolveIdentityRoute, async (c) =>
    c.json(
      identityDecisionSchema.parse(
        await resolveIdentityReview(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").review,
          c.req.valid("json"),
          c.env.observedAt,
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(inspectReconciledPrintingRoute, async (c) =>
    c.json(
      reconciledPrintingSchema.parse(
        await showReconciledPrinting(c.env.env.CATALOGUE_DB, c.req.valid("param").printing),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(validateCorrectionRoute, async (c) =>
    c.json(
      correctionValidationSchema.parse(await validateIdentityCorrection(c.env.env.CATALOGUE_DB, c.req.valid("json"))),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(createCorrectionRoute, async (c) =>
    c.json(
      correctionInspectionSchema.parse(
        await createIdentityCorrection(c.env.env.CATALOGUE_DB, c.req.valid("json"), c.env.observedAt),
      ),
      201,
      headers,
    ),
  ),
  httpRoute<Context>()(inspectCorrectionRoute, async (c) =>
    c.json(
      correctionInspectionSchema.parse(
        await inspectIdentityCorrection(c.env.env.CATALOGUE_DB, c.req.valid("param").correction),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(listCorrectionsRoute, async (c) =>
    c.json(
      correctionsSchema.parse(
        await listIdentityCorrections(
          c.env.env.CATALOGUE_DB,
          c.req.valid("query").game,
          Number(c.req.valid("query").after ?? "0"),
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(listEntityProposalsRoute, async (c) =>
    c.json(
      entityProposalsSchema.parse(
        await listEntityProposals(c.env.env.CATALOGUE_DB, c.req.valid("query").game, c.req.valid("query").after ?? ""),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(proposalEvidenceRoute, async (c) =>
    c.json(
      proposalEvidenceSchema.parse(
        await inspectProposalSourceEvidence(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").proposal,
          c.req.valid("query").after ?? "",
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(createEntityProposalRoute, async (c) =>
    c.json(
      entityProposalSchema.parse(
        await createEntityProposal(c.env.env.CATALOGUE_DB, c.req.valid("json"), c.env.observedAt),
      ),
      201,
      headers,
    ),
  ),
  httpRoute<Context>()(inspectEntityProposalRoute, async (c) =>
    c.json(
      entityProposalSchema.parse(
        await inspectEntityProposal(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").proposal,
          Number(c.req.valid("query").after_generation ?? "0"),
        ),
      ),
      200,
      headers,
    ),
  ),
  httpRoute<Context>()(decideEntityProposalRoute, async (c) =>
    c.json(
      entityProposalSchema.parse(
        await decideEntityProposal(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").proposal,
          c.req.valid("json"),
          c.env.observedAt,
        ),
      ),
      200,
      headers,
    ),
  ),
];
