import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { inspectGameCandidate, inspectGameCandidateReadiness } from "./game-candidate";
import { publicationPreparationGuard, publicationPreparationStatement } from "./publication-preparation-repository";
import {
  publicationOperationStatement,
  retainPublicationApproval,
  retainPublicPackageManifest,
} from "./game-publication-repository";

export type PublicationOperation = {
  id: string;
  candidate_id: string;
  preparation_id: string;
  ingestion_run_id: string;
  supported_game: string;
  manifest_digest: string;
  expected_game_revision_id: string;
  candidate_generation: number;
  deadline: string;
  approved_at: string;
  inspection_receipt: string;
  idempotency_key: string;
  request_json: string;
  approval_json: string;
  generation: number;
  state: string;
  failure_code: string | null;
  resulting_revision_id: string | null;
  backup_attempt_id: string | null;
  published_at: string | null;
};
export async function inspectPublication(db: CatalogueStore, id: string) {
  const row = await publicationOperationStatement(db, id).first<PublicationOperation>();
  if (!row) throw new AdministrationProblem(404, "publication_not_found", "The publication operation does not exist.");
  return publicationDocument(row);
}
function publicationDocument(row: PublicationOperation) {
  const { request_json: _request, approval_json: _approval, idempotency_key: _key, ...status } = row;
  return { contract: "card-keepr-game-publication@1", approval_scope: "whole_candidate", ...status };
}
export async function approveGamePublication(
  db: CatalogueStore,
  input: {
    candidate_id: string;
    manifest_digest: string;
    expected_game_revision_id: string;
    generation: number;
    idempotency_key: string;
  },
  at: string,
) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !/^[a-f0-9]{64}$/.test(input.manifest_digest))
    throw new AdministrationProblem(
      422,
      "invalid_publication_approval",
      "Use the exact manifest and candidate generation.",
    );
  const request = canonicalJson(input);
  const replay = async () => {
    const prior = await publicationOperationStatement(db, input.idempotency_key, true).first<PublicationOperation>();
    if (!prior) return null;
    if (prior.request_json !== request)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another exact approval.");
    return JSON.parse(prior.approval_json) as ReturnType<typeof publicationDocument>;
  };
  const prior = await replay();
  if (prior) return prior;
  const candidate = await inspectGameCandidate(db, input.candidate_id);
  if (candidate.expected_game_revision_id !== input.expected_game_revision_id)
    throw new AdministrationProblem(409, "game_revision_mismatch", "Approve the candidate's exact game predecessor.");
  const readiness = await inspectGameCandidateReadiness(db, candidate.id, input.manifest_digest, at);
  if (!readiness.ready) throw new AdministrationProblem(409, "candidate_not_ready", String(readiness.reason));
  const id = `publication_${crypto.randomUUID()}`;
  const row: PublicationOperation = {
    id,
    candidate_id: candidate.id,
    preparation_id: candidate.preparation_id,
    ingestion_run_id: candidate.ingestion_run_id,
    supported_game: candidate.supported_game,
    manifest_digest: input.manifest_digest,
    expected_game_revision_id: input.expected_game_revision_id,
    candidate_generation: input.generation,
    deadline: candidate.deadline,
    approved_at: at,
    inspection_receipt: readiness.integrity!.sha256,
    idempotency_key: input.idempotency_key,
    request_json: request,
    approval_json: "",
    generation: 0,
    state: "approved",
    failure_code: null,
    resulting_revision_id: null,
    backup_attempt_id: null,
    published_at: null,
  };
  const document = publicationDocument(row);
  try {
    await db.batch([
      publicationPreparationGuard(db, candidate.id, input.manifest_digest, input.generation, at),
      retainPublicationApproval(db, {
        id,
        candidate: candidate.id,
        manifest: input.manifest_digest,
        predecessor: input.expected_game_revision_id,
        generation: input.generation,
        deadline: candidate.deadline,
        at,
        receipt: row.inspection_receipt,
        key: input.idempotency_key,
        request,
        approval: canonicalJson(document),
      }),
    ]);
  } catch {
    const winner = await replay();
    if (winner) return winner;
    throw new AdministrationProblem(
      409,
      "publication_approval_conflict",
      "The exact candidate approval could not be reserved.",
    );
  }
  return document;
}

import { composePublicationArtifacts } from "./publication-preparation";
import {
  publicExportPreparationStatement,
  publicationCompositionHead,
  compositionGamesStatement,
  publicationCheckpointStatement,
  updatePublicationState,
  publicationSwitchStatements,
} from "./game-publication-repository";

export async function advanceGamePublication(
  env: { CATALOGUE_DB: CatalogueStore; CATALOGUE_EXPORTS: R2Bucket; PRINTING_IMAGES: R2Bucket },
  id: string,
  generation: number,
  at = new Date().toISOString(),
) {
  const db = env.CATALOGUE_DB;
  const clockOffsetMs = Date.parse(at) - Date.now();
  const operation = await publicationOperationStatement(db, id).first<PublicationOperation>();
  if (!operation)
    throw new AdministrationProblem(404, "publication_not_found", "The publication operation does not exist.");
  if (["published", "failed", "retry_paused"].includes(operation.state)) return inspectPublication(db, id);
  if (operation.generation !== generation)
    throw new AdministrationProblem(409, "publication_writer_conflict", "Use the current publication generation.");
  if (operation.deadline <= at) {
    await updatePublicationState(db, id, generation, "failed", "publication_deadline_expired").run();
    return inspectPublication(db, id);
  }
  const candidate = await inspectGameCandidate(db, operation.candidate_id);
  const ready = await inspectGameCandidateReadiness(db, candidate.id, operation.manifest_digest, at);
  if (!ready.ready || candidate.generation !== operation.candidate_generation) {
    await updatePublicationState(db, id, generation, "failed", "publication_candidate_conflict").run();
    return inspectPublication(db, id);
  }
  const prepared = await publicationPreparationStatement(db, candidate.id).first<{ state: string }>();
  if (prepared?.state !== "verified") {
    await updatePublicationState(db, id, generation, "waiting_artifacts").run();
    return inspectPublication(db, id);
  }
  const publicExport = await publicExportPreparationStatement(db, candidate.id).first<{
    state: string;
    failure_code: string | null;
  }>();
  if (publicExport?.state !== "verified") {
    await updatePublicationState(
      db,
      id,
      generation,
      publicExport?.state === "failed" ? "failed" : "waiting_artifacts",
      publicExport?.failure_code ?? null,
    ).run();
    return inspectPublication(db, id);
  }
  // Retry unrelated-game contention by refreshing at most four immutable roots.
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = (await publicationCompositionHead(db).first<{ current_revision_id: string }>())!.current_revision_id;
    if (!(await publicationCheckpointStatement(db, head).first<{ ready: number }>())!.ready) {
      await updatePublicationState(db, id, generation, "waiting_backup").run();
      return inspectPublication(db, id);
    }
    const members = (await compositionGamesStatement(db, head).all<{ supported_game: string; candidate_id: string }>())
      .results;
    const composition = await composePublicationArtifacts(
      env,
      [
        ...members.filter((m) => m.supported_game !== candidate.supported_game).map((m) => m.candidate_id),
        candidate.id,
      ],
      true,
    );
    const packageKey = `catalogue-public-manifests/catrev_${id.slice("publication_".length)}/${composition.root_digest}.json`;
    const packageContent = canonicalJson({ contract: composition.contract, games: composition.games });
    await env.CATALOGUE_EXPORTS.put(packageKey, packageContent, { onlyIf: { etagDoesNotMatch: "*" } });
    const retainedPackage = await env.CATALOGUE_EXPORTS.get(packageKey);
    if (
      !retainedPackage ||
      retainedPackage.size > 16384 ||
      (await sha256Text(await retainedPackage.text())) !== composition.root_digest
    )
      throw new AdministrationProblem(
        409,
        "publication_artifacts_unverified",
        "The immutable public package manifest failed verification.",
      );
    await retainPublicPackageManifest(db, id, generation, composition.root_digest, packageKey).run();
    try {
      await db.batch(
        publicationSwitchStatements(db, {
          id,
          generation,
          predecessor: head,
          composition: composition.root_digest,
          at: new Date(Date.now() + clockOffsetMs).toISOString(),
          clockOffsetMs,
          revision: `catrev_${id.slice("publication_".length)}`,
          backup: `backup_${id.slice("publication_".length)}`,
        }),
      );
      return inspectPublication(db, id);
    } catch (error) {
      const current = await inspectPublication(db, id);
      if (current.state === "published") return current;
      if (error instanceof Error && /publication_(deadline_expired|candidate_conflict)/.test(error.message)) {
        await updatePublicationState(
          db,
          id,
          generation,
          "failed",
          error.message.includes("deadline_expired")
            ? "publication_deadline_expired"
            : "publication_candidate_conflict",
        ).run();
        return inspectPublication(db, id);
      }
      if (error instanceof Error && error.message.includes("publication_composition_conflict")) continue;
      if (error instanceof Error && error.message.includes("publication_backup_pending")) {
        await updatePublicationState(db, id, generation, "waiting_backup").run();
        return inspectPublication(db, id);
      }
      throw error;
    }
  }
  await updatePublicationState(db, id, generation, "retry_paused", "publication_composition_contention").run();
  return inspectPublication(db, id);
}

import { workflowDriver } from "../shared";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";
export async function startGamePublication(
  env: Parameters<typeof advanceGamePublication>[0] & {
    RECONCILIATION_WORKFLOW: Workflow<ReconciliationWorkflowParams>;
  },
  input: Parameters<typeof approveGamePublication>[1],
  at: string,
) {
  const approval = await approveGamePublication(env.CATALOGUE_DB, input, at);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await dispatchGamePublication(
        env.RECONCILIATION_WORKFLOW,
        await inspectPublication(env.CATALOGUE_DB, approval.id),
      );
      break;
    } catch {
      if (attempt === 2)
        await pauseGamePublication(
          env.CATALOGUE_DB,
          approval.id,
          approval.generation,
          "publication_dispatch_retry_exhausted",
        );
    }
  }
  return approval;
}
export async function dispatchGamePublication(
  workflow: Workflow<ReconciliationWorkflowParams>,
  operation: Awaited<ReturnType<typeof inspectPublication>>,
  shard = 0,
  waits = 0,
) {
  if (["published", "failed", "retry_paused"].includes(operation.state)) return;
  const id = `switch-${await sha256Text(`${operation.id}:${operation.generation}${shard ? `:${shard}` : ""}`)}`;
  await workflowDriver(workflow).ensure(
    id,
    {
      ingestion_run_id: operation.ingestion_run_id,
      preparation_id: operation.preparation_id,
      expected_current_revision_id: operation.expected_game_revision_id,
      idempotency_key: operation.id,
      observed_at: operation.approved_at,
      publication: { id: operation.id, generation: operation.generation, shard, waits },
    },
    { createRequested: true },
  );
}

import {
  publicationResumeAction,
  publicationResumeStatements,
  pausePublicationSuccessor,
} from "./game-publication-repository";
export async function pauseGamePublication(
  db: CatalogueStore,
  id: string,
  generation: number,
  code: string,
  successor?: { shard: number; sequence: number },
) {
  await (successor
    ? pausePublicationSuccessor(db, id, generation, successor.shard, successor.sequence)
    : updatePublicationState(db, id, generation, "retry_paused", code)
  ).run();
  return inspectPublication(db, id);
}
export async function resumeGamePublication(
  env: Parameters<typeof startGamePublication>[0],
  id: string,
  input: { generation: number; idempotency_key: string },
  at: string,
) {
  const request = canonicalJson({ id, ...input });
  const prior = await publicationResumeAction(env.CATALOGUE_DB, input.idempotency_key).first<{
    request_json: string;
    result_json: string;
  }>();
  if (prior) {
    if (prior.request_json !== request)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another publication resume.");
    await dispatchGamePublication(env.RECONCILIATION_WORKFLOW, await inspectPublication(env.CATALOGUE_DB, id));
    return JSON.parse(prior.result_json) as Awaited<ReturnType<typeof inspectPublication>>;
  }
  const current = await inspectPublication(env.CATALOGUE_DB, id);
  const result = { ...current, generation: input.generation + 1, state: "approved", failure_code: null };
  try {
    await env.CATALOGUE_DB.batch(
      publicationResumeStatements(
        env.CATALOGUE_DB,
        id,
        input.generation,
        input.idempotency_key,
        request,
        canonicalJson(result),
        at,
      ),
    );
  } catch {
    const winner = await publicationResumeAction(env.CATALOGUE_DB, input.idempotency_key).first<{
      request_json: string;
    }>();
    if (winner?.request_json === request) return resumeGamePublication(env, id, input, at);
    throw new AdministrationProblem(
      409,
      "publication_resume_conflict",
      "The publication generation, deadline or recovery fence does not permit resumption.",
    );
  }
  await dispatchGamePublication(env.RECONCILIATION_WORKFLOW, result);
  return result;
}
