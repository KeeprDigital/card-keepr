import {
  startGamePublication,
  advanceGamePublication,
  approveGamePublication,
  inspectPublication,
} from "./game-publication";
import { startPublicationPreparation } from "./publication-preparation-dispatch";
import {
  advancePublicationPreparation,
  inspectPublicationPreparation,
  inspectPublicationArtifacts,
  composePublicationArtifacts,
  inspectPreparedQuery,
} from "./publication-preparation";
import { inspectCandidateEvidence, candidateImageContent } from "./game-candidate-inspection";
import {
  inspectGameCandidate,
  inspectGameCandidateReadiness,
  inspectGameCandidatePartitions,
  inspectGameCandidatePartition,
  listCollectionGameCandidates,
  inspectGameCandidateProgress,
} from "./game-candidate";
import { createGameReconciliation, changeGameReconciliation } from "./game-reconciliation";
import {
  changeReconciliationProgress,
  inspectReconciliationInputs,
  inspectReconciliationInput,
  inspectReconciliationPartitions,
  inspectReconciliationPartition,
  inspectReconciliationProgress,
  inspectReconciliationText,
} from "./reconciliation-progress";
import {
  validateIdentityCorrection,
  createIdentityCorrection,
  inspectIdentityCorrection,
  listIdentityCorrections,
} from "./identity-corrections";
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
import { resumeReconciliationWorkflow, startOrObserveReconciliationWorkflow } from "./reconciliation-workflow";

type Environment = {
  CATALOGUE_DB: CatalogueStore;
  PRINTING_IMAGES: R2Bucket;
  CATALOGUE_EXPORTS: R2Bucket;
  RECONCILIATION_WORKFLOW: Parameters<typeof startOrObserveReconciliationWorkflow>[1];
};
type Context = RouteContext<Environment> & { observedAt: string };

export const reconciliationRoutes = [
  route<Context>("POST", "/v1/publications/:publication/advance", async ({ env, request, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["generation"]);
    return Response.json(await advanceGamePublication(env, params.publication!, Number(body.generation), observedAt));
  }),
  route<Context>("GET", "/v1/publications/:publication", async ({ env }, params) =>
    Response.json(await inspectPublication(env.CATALOGUE_DB, params.publication!)),
  ),
  ...(["", "/start"] as const).map((suffix) =>
    route<Context>("POST", `/v1/publications${suffix}`, async ({ env, request, observedAt }) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, [
        "candidate_id",
        "manifest_digest",
        "expected_game_revision_id",
        "generation",
        "idempotency_key",
      ]);
      return Response.json(
        await (suffix
          ? (input: Parameters<typeof approveGamePublication>[1], at: string) => startGamePublication(env, input, at)
          : (input: Parameters<typeof approveGamePublication>[1], at: string) =>
              approveGamePublication(env.CATALOGUE_DB, input, at))(
          {
            candidate_id: requiredString(body, "candidate_id"),
            manifest_digest: requiredString(body, "manifest_digest"),
            expected_game_revision_id: requiredString(body, "expected_game_revision_id"),
            generation: Number(body.generation),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        ),
        { status: 202 },
      );
    }),
  ),
  route<Context>(
    "GET",
    "/v1/game-candidates/:candidate/publication-preparation/query",
    async ({ env, request }, params) =>
      Response.json(await inspectPreparedQuery(env.CATALOGUE_DB, params.candidate!, new URL(request.url).searchParams)),
  ),
  route<Context>("POST", "/v1/publication-compositions", async ({ env, request }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["candidate_ids"]);
    return Response.json(await composePublicationArtifacts(env, body.candidate_ids));
  }),
  route<Context>("GET", "/v1/game-candidates/:candidate/publication-preparation", async ({ env }, params) =>
    Response.json(await inspectPublicationPreparation(env.CATALOGUE_DB, params.candidate!)),
  ),
  route<Context>(
    "GET",
    "/v1/game-candidates/:candidate/publication-preparation/artifacts",
    async ({ env, request }, params) =>
      Response.json(
        await inspectPublicationArtifacts(
          env.CATALOGUE_DB,
          params.candidate!,
          new URL(request.url).searchParams.get("after"),
        ),
      ),
  ),
  ...(["", "/start", "/resume"] as const).map((suffix) =>
    route<Context>(
      "POST",
      `/v1/game-candidates/:candidate/publication-preparation${suffix}`,
      async ({ env, request, observedAt }, params) => {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["manifest_digest", "generation", "sequence", "idempotency_key", "resume"]);
        return Response.json(
          await (suffix ? startPublicationPreparation : advancePublicationPreparation)(
            env,
            params.candidate!,
            {
              manifest_digest: requiredString(body, "manifest_digest"),
              generation: Number(body.generation),
              sequence: Number(body.sequence),
              idempotency_key: requiredString(body, "idempotency_key"),
              ...(suffix === "/resume"
                ? { resume: true }
                : body.resume === undefined
                  ? {}
                  : { resume: body.resume === true }),
            },
            observedAt,
          ),
          { status: suffix ? 202 : 200 },
        );
      },
    ),
  ),
  route<Context>(
    "GET",
    "/v1/game-candidates/:candidate/partitions/:ordinal/images/:record",
    async ({ env, request }, params) => {
      const candidate = await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!);
      const manifest = new URL(request.url).searchParams.get("manifest");
      if (manifest !== null && manifest !== candidate.manifest_digest)
        throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use the exact candidate manifest.");
      return candidateImageContent(
        env.CATALOGUE_DB,
        env.PRINTING_IMAGES,
        candidate.id,
        params.ordinal!,
        params.record!,
        new URL(request.url).searchParams.get("side") ?? "after",
      );
    },
  ),
  route<Context>(
    "GET",
    "/v1/game-candidates/:candidate/inspection/evidence/:kind",
    async ({ env, request }, params) => {
      const candidate = await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!);
      const query = new URL(request.url).searchParams;
      return Response.json(
        await inspectCandidateEvidence(
          env.CATALOGUE_DB,
          candidate,
          params.kind!,
          query.get("after"),
          query.get("manifest"),
        ),
      );
    },
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate/inspection", async ({ env, request, observedAt }, params) =>
    Response.json(
      await inspectGameCandidateReadiness(
        env.CATALOGUE_DB,
        params.candidate!,
        new URL(request.url).searchParams.get("manifest"),
        observedAt,
      ),
    ),
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate/progress", async ({ env }, params) =>
    Response.json(await inspectGameCandidateProgress(env.CATALOGUE_DB, params.candidate!)),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/game-candidates", async ({ env, request }, params) =>
    Response.json(
      await listCollectionGameCandidates(env.CATALOGUE_DB, params.run!, new URL(request.url).searchParams.get("after")),
    ),
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate/text/:digest/:ordinal", async ({ env }, params) => {
    const candidate = await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!);
    const text = await inspectReconciliationText(
      env.CATALOGUE_DB,
      candidate.preparation_id,
      params.digest!,
      params.ordinal!,
    );
    return Response.json({
      ...text,
      ingestion_run_id: candidate.ingestion_run_id,
      preparation_id: candidate.preparation_id,
    });
  }),
  route<Context>("GET", "/v1/game-candidates/:candidate/inputs", async ({ env, request }, params) => {
    const candidate = await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!);
    const inputs = await inspectReconciliationInputs(
      env.CATALOGUE_DB,
      candidate.preparation_id,
      new URL(request.url).searchParams.get("after"),
    );
    return Response.json({
      ...inputs,
      ingestion_run_id: candidate.ingestion_run_id,
      preparation_id: candidate.preparation_id,
    });
  }),
  route<Context>("GET", "/v1/game-candidates/:candidate/inputs/:ordinal", async ({ env }, params) => {
    const candidate = await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!);
    const input = await inspectReconciliationInput(env.CATALOGUE_DB, candidate.preparation_id, params.ordinal!);
    return Response.json({
      ...input,
      ingestion_run_id: candidate.ingestion_run_id,
      preparation_id: candidate.preparation_id,
    });
  }),
  route<Context>("POST", "/v1/game-candidates", async ({ env, request, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["ingestion_run_id", "supported_game", "expected_game_revision_id", "idempotency_key"]);
    const result = await createGameReconciliation(
      env.CATALOGUE_DB,
      env.RECONCILIATION_WORKFLOW,
      {
        ingestion_run_id: requiredString(body, "ingestion_run_id"),
        supported_game: requiredString(body, "supported_game"),
        expected_game_revision_id: requiredString(body, "expected_game_revision_id"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(result.document, { status: result.created ? 201 : 200 });
  }),
  ...(["pause", "resume", "abandon"] as const).map((action) =>
    route<Context>("POST", `/v1/game-candidates/:candidate/${action}`, async ({ env, request, observedAt }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["generation", "idempotency_key"]);
      return Response.json(
        await changeGameReconciliation(
          env.CATALOGUE_DB,
          env.RECONCILIATION_WORKFLOW,
          params.candidate!,
          action,
          { generation: Number(body.generation), idempotency_key: requiredString(body, "idempotency_key") },
          observedAt,
        ),
      );
    }),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/text/:digest/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationText(env.CATALOGUE_DB, params.run!, params.digest!, params.ordinal!)),
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate", async ({ env }, params) =>
    Response.json(await inspectGameCandidate(env.CATALOGUE_DB, params.candidate!)),
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate/partitions", async ({ env, request }, params) =>
    Response.json(
      await inspectGameCandidatePartitions(
        env.CATALOGUE_DB,
        params.candidate!,
        new URL(request.url).searchParams.get("after"),
        new URL(request.url).searchParams.get("manifest"),
      ),
    ),
  ),
  route<Context>("GET", "/v1/game-candidates/:candidate/partitions/:ordinal", async ({ env, request }, params) =>
    Response.json(
      await inspectGameCandidatePartition(
        env.CATALOGUE_DB,
        params.candidate!,
        params.ordinal!,
        new URL(request.url).searchParams.get("manifest"),
      ),
    ),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/inputs", async ({ env, request }, params) =>
    Response.json(
      await inspectReconciliationInputs(env.CATALOGUE_DB, params.run!, new URL(request.url).searchParams.get("after")),
    ),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/inputs/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationInput(env.CATALOGUE_DB, params.run!, params.ordinal!)),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/partitions/:ordinal", async ({ env }, params) =>
    Response.json(await inspectReconciliationPartition(env.CATALOGUE_DB, params.run!, params.ordinal!)),
  ),
  ...(["pause", "resume", "abandon"] as const).map((action) =>
    route<Context>(
      "POST",
      `/v1/ingestion-runs/:run/reconciliation/${action}`,
      async ({ env, request, observedAt }, params) => {
        const body = await readAdministrationBody(request);
        assertOnlyFields(body, ["generation", "idempotency_key"]);
        const result = await changeReconciliationProgress(
          env.CATALOGUE_DB,
          params.run!,
          action,
          {
            generation: Number(body.generation),
            idempotency_key: requiredString(body, "idempotency_key"),
          },
          observedAt,
        );
        if (action === "resume")
          await resumeReconciliationWorkflow(env.CATALOGUE_DB, env.RECONCILIATION_WORKFLOW, params.run!);
        return Response.json(result);
      },
    ),
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation/partitions", async ({ env, request }, params) => {
    return Response.json(
      await inspectReconciliationPartitions(
        env.CATALOGUE_DB,
        params.run!,
        new URL(request.url).searchParams.get("after"),
      ),
    );
  }),
  route<Context>("GET", "/v1/ingestion-runs/:run/reconciliation", async ({ env }, params) => {
    return Response.json(await inspectReconciliationProgress(env.CATALOGUE_DB, params.run!));
  }),
  route<Context>("POST", "/v1/identity-corrections/validate", async ({ request, env }) =>
    Response.json(await validateIdentityCorrection(env.CATALOGUE_DB, await readAdministrationBody(request))),
  ),
  route<Context>("POST", "/v1/identity-corrections", async ({ request, env, observedAt }) =>
    Response.json(await createIdentityCorrection(env.CATALOGUE_DB, await readAdministrationBody(request), observedAt), {
      status: 201,
    }),
  ),
  route<Context>("GET", "/v1/identity-corrections/:correction", async ({ env }, params) =>
    Response.json(await inspectIdentityCorrection(env.CATALOGUE_DB, params.correction!)),
  ),
  route<Context>("GET", "/v1/identity-corrections", async ({ env, request }) => {
    const query = new URL(request.url).searchParams;
    const after = Number(query.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0)
      throw new AdministrationProblem(422, "correction_cursor_invalid", "Use a non-negative sequence.");
    return Response.json(await listIdentityCorrections(env.CATALOGUE_DB, query.get("game") ?? "", after));
  }),
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
      "content",
      "evidence",
    ]);
    return Response.json(
      await decideEntityProposal(
        env.CATALOGUE_DB,
        params.proposal!,
        {
          ...(body.exception === undefined ? {} : { exception: body.exception }),
          ...(body.content === undefined ? {} : { content: body.content }),
          ...(body.evidence === undefined ? {} : { evidence: body.evidence }),
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
      await inspectIdentityReviews(
        env.CATALOGUE_DB,
        query.get("run_id") ?? "",
        query.get("after") ?? "",
        query.get("preparation_id"),
      ),
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
        new URL(request.url).searchParams.get("preparation_id"),
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
