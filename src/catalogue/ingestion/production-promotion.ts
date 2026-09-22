import { readAdministrationBody } from "../../http/administration";
import { retainedWireValue } from "../../http/openapi";
import {
  verifyExtendedScenarios,
  verifyPromotionWorkflow,
  verifyReleaseCommit,
} from "../../http/dev-workflow-identity.mjs";
import { environmentNames } from "../../http/environment-target.mjs";
import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import { currentDisposableRestoreDatabaseId } from "../backup-recovery";
import {
  AdministrationProblem,
  type CatalogueStore,
  canonicalJson,
  sha256Text,
  validateStagingOutcome,
} from "../shared";
import { administrationStatus } from "./administration-inspection";
import { resolveProductionRelease } from "./production-release-preparation";
import {
  promotionRecordStatement,
  recordProductionPromotionStatement,
  recordPromotionStopStatement,
} from "./production-promotion-repository";
import {
  productionPromotionReceiptSchema,
  productionPromotionRequestSchema,
  stagingOutcomeReceiptSchema,
} from "./platform-http-contract";
import type { StagingAuthorization } from "./staging-authorization";
import { showStagingRelease } from "./staging-release";

type PromotionEnvironment = {
  KEEPR_ENVIRONMENT?: string;
  CATALOGUE_DB: CatalogueStore;
  CATALOGUE_EXPORTS: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  CATALOGUE_D1_DATABASE_ID: string;
  D1_VERIFICATION_TOKEN: string;
};
type RecordRow = { operation: string; request_json: string; response_json: string };
type PromotionReceipt = { workflow_run_id: string } & Record<string, unknown>;

const stop = (status: number, code: string, detail: string): never => {
  throw new AdministrationProblem(status, code, detail);
};

/**
 * Automatic promotion (#238): the owner's staging intent is the single approval.
 * Production binds that intent to its own signed staging claim, the staging outcome
 * it fetches from staging, the per-commit extended-scenarios record and fresh
 * production guards, then resolves a fresh plan with the owner resolver. The
 * immutable promotion record replaces the owner's production confirmation envelope.
 */
export async function handleProductionPromotion(
  request: Request,
  env: PromotionEnvironment,
  at = new Date().toISOString(),
): Promise<Response> {
  if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production" || request.method !== "POST")
    throw new AdministrationProblem(404, "not_found", "Route not found.");
  const parsed = productionPromotionRequestSchema.safeParse(await readAdministrationBody(request));
  if (!parsed.success)
    stop(422, "invalid_production_promotion", "The staging release, intent digest and selected commit are required.");
  const body = parsed.data!;
  const githubToken = request.headers.get("x-github-token") ?? "";
  let identity: Awaited<ReturnType<typeof verifyPromotionWorkflow>>;
  try {
    identity = await verifyPromotionWorkflow(
      request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "",
      githubToken,
      Date.parse(at),
    );
  } catch {
    throw new AdministrationProblem(
      403,
      "invalid_promotion_workflow_attestation",
      "The staging workflow's production promotion identity could not be verified.",
    );
  }
  const requestJson = canonicalJson(body);
  try {
    return await promote(request, env, body, identity, githubToken, requestJson, at);
  } catch (error) {
    // Only a verified workflow run can leave stop evidence; stops never block a retry.
    if (error instanceof AdministrationProblem)
      await recordPromotionStopStatement(env.CATALOGUE_DB, {
        key: `production-promotion-stop:${body.release_id}:${identity.runId}:${error.code}`,
        request: requestJson,
        response: canonicalJson({
          code: error.code,
          detail: error.message,
          workflow_run_id: identity.runId,
          workflow_run_attempt: identity.runAttempt,
        }),
        status: error.status,
        at,
      })
        .run()
        .catch(() => undefined);
    throw error;
  }
}

async function promote(
  request: Request,
  env: PromotionEnvironment,
  body: { release_id: string; intent_digest: string; expected_head_sha: string },
  identity: Awaited<ReturnType<typeof verifyPromotionWorkflow>>,
  githubToken: string,
  requestJson: string,
  at: string,
): Promise<Response> {
  const database = env.CATALOGUE_DB;
  const recorded = await showStagingRelease(database, body.release_id);
  const intent = recorded.intent;
  if (recorded.intent_digest !== body.intent_digest || (await sha256Text(canonicalJson(intent))) !== body.intent_digest)
    stop(409, "promotion_intent_mismatch", "The exact staging intent does not match.");
  if (intent.expected_head_sha !== body.expected_head_sha)
    stop(409, "promotion_commit_mismatch", "The selected commit is not the owner's staging commit.");
  if (identity.actor !== intent.expected_actor)
    stop(409, "promotion_actor_mismatch", "The workflow run was not started by the staging intent's owner.");
  const claimRow = await promotionRecordStatement(database, `staging-claim:${body.intent_digest}`).first<RecordRow>();
  if (claimRow?.operation !== "authorize_staging_release")
    stop(409, "staging_release_not_claimed", "No staging workflow claimed this intent.");
  const claim = JSON.parse(claimRow!.response_json) as StagingAuthorization;
  if (claim.workflow_run_id !== identity.runId)
    stop(409, "promotion_run_mismatch", "Only the workflow run that executed this staging release can promote it.");

  const key = `production-promotion:${body.release_id}`;
  const prior = await existingPromotion(database, key, requestJson, identity.runId);
  if (prior !== null) return promotionResponse(prior, 200);

  if (!(Date.parse(intent.expires_at) > Date.parse(at)))
    stop(409, "promotion_intent_expired", "The owner's staging intent expired; a new staging release is required.");
  const productionReleaseId = `promotion-${body.release_id}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(productionReleaseId))
    stop(422, "invalid_production_promotion", "This staging release identity cannot name a Production Release.");

  const outcome = await stagingOutcome(request, body.release_id, claim, intent);

  let extended: Awaited<ReturnType<typeof verifyExtendedScenarios>>;
  try {
    extended = await verifyExtendedScenarios(githubToken, intent.expected_head_sha);
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("extended_scenarios_") ? error.message : "";
    const known = ["extended_scenarios_missing", "extended_scenarios_pending", "extended_scenarios_failed"];
    throw new AdministrationProblem(
      409,
      known.includes(code) ? code : "extended_scenarios_unverified",
      "The selected commit has no verified successful extended-scenarios record.",
    );
  }
  try {
    await verifyReleaseCommit(githubToken, { head_sha: intent.expected_head_sha, ci_run_id: intent.ci_run_id });
  } catch {
    stop(409, "promotion_ci_not_verified", "The selected commit's complete CI success on main could not be verified.");
  }

  // Fresh production guards: the intent's starting snapshot is compared, never reused.
  const names = environmentNames("production");
  const disposableId = await currentDisposableRestoreDatabaseId(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.D1_VERIFICATION_TOKEN,
    names.disposable,
  );
  const target = validatedEnvironmentTarget(
    {
      cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
      worker_scripts: names.workers,
      d1_databases: [
        { name: names.catalogue, id: env.CATALOGUE_D1_DATABASE_ID },
        { name: names.disposable, id: disposableId },
      ],
      r2_buckets: names.buckets,
    },
    "production",
  );
  if (target === null || (await sha256Text(canonicalJson(target))) !== intent.production_start.target_digest)
    stop(409, "promotion_target_changed", "The production target changed since the owner's staging intent.");
  const status = await administrationStatus(database, env.CATALOGUE_EXPORTS, at, target!, false);
  const safe = status.safe_state as Record<string, unknown>;
  const preflight = status.release_preflight as Record<string, unknown>;
  if (preflight.schema_migration_level !== intent.production_start.migration_level)
    stop(409, "promotion_schema_changed", "The production schema level changed since the owner's staging intent.");
  // mutation_safe already treats an expired lease as released.
  if (safe.mutation_safe !== true && safe.active_production_release_id != null)
    stop(409, "promotion_release_competing", "Another Production Release holds the production lease.");
  if (safe.mutation_safe !== true || safe.recovery_health !== "healthy")
    stop(409, "promotion_production_not_idle", "Production is not idle with healthy recovery.");

  const choices = {
    release_id: productionReleaseId,
    idempotency_key: `promotion:${body.release_id}:${identity.runId}`,
    expected_head_sha: intent.expected_head_sha,
    expected_actor: "github-actions[bot]",
    expected_current_revision_id: safe.current_revision_id,
    expected_migration_level: preflight.schema_migration_level,
    bootstrap: preflight.bootstrap,
    replacement_handoff: null,
  };
  let prepared: Record<string, unknown>;
  try {
    const preview = await resolveProductionRelease(
      database,
      env.CATALOGUE_EXPORTS,
      { ...choices, prepare: true },
      target!,
      at,
    );
    prepared = await resolveProductionRelease(
      database,
      env.CATALOGUE_EXPORTS,
      { ...choices, confirmation: preview.confirmation },
      target!,
      at,
    );
  } catch (error) {
    if (!(error instanceof AdministrationProblem)) throw error;
    throw new AdministrationProblem(
      409,
      "promotion_preflight_failed",
      `Production did not satisfy the guarded release preflight (${error.code}).`,
    );
  }
  const receipt: PromotionReceipt = {
    contract: "card-keepr-production-promotion@1",
    staging_release_id: body.release_id,
    intent_digest: body.intent_digest,
    expected_head_sha: intent.expected_head_sha,
    confirmed_by: `promotion:${body.release_id}/${identity.runId}`,
    workflow_run_id: identity.runId,
    workflow_run_attempt: identity.runAttempt,
    ci_run_id: intent.ci_run_id,
    staging_outcome_sha256: await sha256Text(canonicalJson(outcome)),
    extended_scenarios: extended,
    production_start: {
      target_digest: intent.production_start.target_digest,
      migration_level: intent.production_start.migration_level,
    },
    promoted_at: at,
    production_release: prepared,
  };
  try {
    await recordProductionPromotionStatement(database, {
      key,
      request: requestJson,
      response: canonicalJson(receipt),
      at,
    }).run();
  } catch {
    const concurrent = await existingPromotion(database, key, requestJson, identity.runId);
    if (concurrent === null) stop(409, "promotion_conflict", "Another promotion record exists for this release.");
    return promotionResponse(concurrent!, 200);
  }
  return promotionResponse(receipt, 201);
}

async function existingPromotion(
  database: CatalogueStore,
  key: string,
  requestJson: string,
  runId: string,
): Promise<PromotionReceipt | null> {
  const row = await promotionRecordStatement(database, key).first<RecordRow>();
  if (row === null) return null;
  const receipt = JSON.parse(row.response_json) as PromotionReceipt;
  if (row.operation !== "production_promotion" || row.request_json !== requestJson || receipt.workflow_run_id !== runId)
    stop(409, "promotion_run_mismatch", "This staging release was already promoted by another request or run.");
  return receipt;
}

/** Production reads the outcome from staging over fixed HTTPS; the runner never supplies it. */
async function stagingOutcome(
  request: Request,
  releaseId: string,
  claim: StagingAuthorization,
  intent: StagingAuthorization["intent"],
): Promise<unknown> {
  const url = `${environmentNames("staging").publicBases.ingestion}/v1/staging-deployments/${encodeURIComponent(releaseId)}/promotion-outcome`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: {
        authorization: request.headers.get("authorization") ?? "",
        "x-github-token": request.headers.get("x-github-token") ?? "",
        "content-type": "application/json",
      },
      body: canonicalJson({ intent_digest: claim.intent_digest }),
    });
  } catch {
    return stop(502, "staging_outcome_unavailable", "Staging did not return the recorded outcome.");
  }
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (response.status === 404 && problem?.code === "staging_outcome_not_found")
      stop(409, "staging_outcome_missing", "Staging has no recorded outcome for this release.");
    stop(502, "staging_outcome_unavailable", "Staging did not return the recorded outcome.");
  }
  const parsed = stagingOutcomeReceiptSchema.safeParse(await response.json().catch(() => null));
  if (
    !parsed.success ||
    parsed.data.release_id !== releaseId ||
    canonicalJson(parsed.data.authorization) !== canonicalJson(claim)
  )
    stop(409, "staging_outcome_mismatch", "The staging outcome is not bound to this production claim.");
  const receipt = parsed.data!;
  try {
    validateStagingOutcome(receipt.outcome, intent, claim.intent_digest);
  } catch {
    stop(409, "staging_outcome_mismatch", "The staging outcome does not match the owner's intent or commit.");
  }
  if (receipt.outcome.state !== "succeeded" || receipt.outcome.deployment.release_id !== releaseId)
    stop(409, "staging_outcome_failed", "The staging release did not succeed.");
  return receipt;
}

function promotionResponse(receipt: PromotionReceipt, status: 200 | 201): Response {
  return Response.json(retainedWireValue(productionPromotionReceiptSchema, receipt), {
    status,
    headers: { "cache-control": "no-store" },
  });
}
