import { assertCandidateManifest, candidateImageContent, inspectCandidateEvidence } from "./game-candidate-inspection";
import {
  inspectReconciliationInputs,
  inspectReconciliationInput,
  inspectReconciliationText,
} from "./reconciliation-progress";
import * as inspection from "./game-candidate-http-contract";
import { httpRoute, streamingHttpRoute } from "../../http/openapi";
import { publicUrl } from "../../http/public-base";
import type { RouteContext } from "../../http/routes";
import type { CatalogueStore } from "../shared";
import { createGameReconciliation, changeGameReconciliation } from "./game-reconciliation";
import {
  inspectGameCandidate,
  inspectGameCandidateReadiness,
  inspectGameCandidatePartitions,
  inspectGameCandidatePartition,
  listCollectionGameCandidates,
  inspectGameCandidateProgress,
} from "./game-candidate";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";
import {
  candidateAcceptanceSchema,
  candidateActionRoute,
  candidateStatusRoute,
  candidateStatusSchema,
  createCandidateRoute,
} from "./game-candidate-http-contract";

type Context = RouteContext<{
  CATALOGUE_DB: CatalogueStore;
  PRINTING_IMAGES: R2Bucket;
  RECONCILIATION_WORKFLOW: Workflow<ReconciliationWorkflowParams>;
}> & { observedAt: string };
function acceptance(
  context: Context,
  document: Record<string, unknown>,
  action: "prepare" | "pause" | "resume" | "abandon",
  key: string,
  generation: number,
) {
  const status = publicUrl(context.base, `/v1/game-candidates/${encodeURIComponent(String(document.id))}`);
  return candidateAcceptanceSchema.parse({
    contract: "card-keepr-game-preparation-acceptance@1",
    id: document.id,
    preparation_id: document.preparation_id,
    ingestion_run_id: document.ingestion_run_id,
    supported_game: document.supported_game,
    expected_game_revision_id: document.expected_game_revision_id,
    created_at: document.created_at,
    deadline: document.deadline,
    action,
    state: "accepted",
    generation,
    idempotency_key: key,
    links: { status },
  });
}
const headers = (status: string) => ({ Location: status, "Retry-After": "2", "Cache-Control": "no-store" });
export const gameCandidateRoutes = [
  httpRoute<Context>()(createCandidateRoute, async (c) => {
    const input = c.req.valid("json");
    const result = await createGameReconciliation(
      c.env.env.CATALOGUE_DB,
      c.env.env.RECONCILIATION_WORKFLOW,
      input,
      c.env.observedAt,
    );
    const receipt = acceptance(c.env, result.document, "prepare", input.idempotency_key, 0);
    return c.json(receipt, 202, headers(receipt.links.status));
  }),
  ...(["pause", "resume", "abandon"] as const).map((action) =>
    httpRoute<Context>()(candidateActionRoute(action), async (c) => {
      const input = c.req.valid("json");
      const result = await changeGameReconciliation(
        c.env.env.CATALOGUE_DB,
        c.env.env.RECONCILIATION_WORKFLOW,
        c.req.valid("param").candidate,
        action,
        input,
        c.env.observedAt,
      );
      const receipt = acceptance(c.env, result, action, input.idempotency_key, input.generation);
      return c.json(receipt, 202, headers(receipt.links.status));
    }),
  ),
  httpRoute<Context>()(candidateStatusRoute, async (c) =>
    c.json(
      candidateStatusSchema.parse(await inspectGameCandidate(c.env.env.CATALOGUE_DB, c.req.valid("param").candidate)),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(inspection.candidateListRoute, async (c) =>
    c.json(
      inspection.candidateListSchema.parse(
        await listCollectionGameCandidates(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").run,
          c.req.valid("query").after ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(inspection.candidateProgressRoute, async (c) =>
    c.json(
      inspection.candidateProgressSchema.parse(
        await inspectGameCandidateProgress(c.env.env.CATALOGUE_DB, c.req.valid("param").candidate),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(inspection.candidateInspectionRoute, async (c) =>
    c.json(
      inspection.candidateInspectionSchema.parse(
        await inspectGameCandidateReadiness(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").candidate,
          c.req.valid("query").manifest ?? null,
          c.env.observedAt,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(inspection.candidatePartitionsRoute, async (c) => {
    const query = c.req.valid("query");
    return c.json(
      inspection.candidatePartitionsSchema.parse(
        await inspectGameCandidatePartitions(
          c.env.env.CATALOGUE_DB,
          c.req.valid("param").candidate,
          query.after ?? null,
          query.manifest ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(inspection.candidatePartitionRoute, async (c) => {
    const params = c.req.valid("param");
    return c.json(
      inspection.candidatePartitionSchema.parse(
        await inspectGameCandidatePartition(
          c.env.env.CATALOGUE_DB,
          params.candidate,
          params.ordinal,
          c.req.valid("query").manifest ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(inspection.candidateEvidenceRoute, async (c) => {
    const params = c.req.valid("param"),
      query = c.req.valid("query");
    const candidate = await inspectGameCandidate(c.env.env.CATALOGUE_DB, params.candidate);
    return c.json(
      inspection.candidateEvidenceSchema.parse(
        await inspectCandidateEvidence(
          c.env.env.CATALOGUE_DB,
          candidate,
          params.kind,
          query.after ?? null,
          query.manifest ?? null,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(inspection.candidateInputsRoute, async (c) => {
    const candidate = await inspectGameCandidate(c.env.env.CATALOGUE_DB, c.req.valid("param").candidate);
    const result = await inspectReconciliationInputs(
      c.env.env.CATALOGUE_DB,
      candidate.preparation_id,
      c.req.valid("query").after ?? null,
    );
    return c.json(
      inspection.candidateInputsSchema.parse({
        ...result,
        ingestion_run_id: candidate.ingestion_run_id,
        preparation_id: candidate.preparation_id,
      }),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(inspection.candidateInputRoute, async (c) => {
    const params = c.req.valid("param");
    const candidate = await inspectGameCandidate(c.env.env.CATALOGUE_DB, params.candidate);
    const result = await inspectReconciliationInput(c.env.env.CATALOGUE_DB, candidate.preparation_id, params.ordinal);
    return c.json(
      inspection.candidateInputSchema.parse({
        ...result,
        ingestion_run_id: candidate.ingestion_run_id,
        preparation_id: candidate.preparation_id,
      }),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(inspection.candidateTextRoute, async (c) => {
    const params = c.req.valid("param");
    const candidate = await inspectGameCandidate(c.env.env.CATALOGUE_DB, params.candidate);
    const result = await inspectReconciliationText(
      c.env.env.CATALOGUE_DB,
      candidate.preparation_id,
      params.digest,
      params.ordinal,
    );
    return c.json(
      inspection.candidateTextSchema.parse({
        ...result,
        ingestion_run_id: candidate.ingestion_run_id,
        preparation_id: candidate.preparation_id,
      }),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  streamingHttpRoute<Context>()(inspection.candidateImageRoute, async (c) => {
    const params = c.req.valid("param"),
      query = c.req.valid("query");
    const candidate = await inspectGameCandidate(c.env.env.CATALOGUE_DB, params.candidate);
    assertCandidateManifest(candidate, query.manifest ?? null);
    return candidateImageContent(
      c.env.env.CATALOGUE_DB,
      c.env.env.PRINTING_IMAGES,
      candidate.id,
      params.ordinal,
      params.record,
      query.side ?? "after",
    );
  }),
];
