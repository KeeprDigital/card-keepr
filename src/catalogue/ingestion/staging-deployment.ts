import { readAdministrationBody } from "../../http/administration";
import { stagingAudience } from "../../http/dev-workflow-identity.mjs";
import { environmentNames } from "../../http/environment-target.mjs";
import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import { currentDisposableRestoreDatabaseId } from "../backup-recovery";
import {
  AdministrationProblem,
  type CatalogueStore,
  canonicalJson,
  isReleaseIdentity,
  sha256Text,
  validateStagingOutcome,
} from "../shared";
import { administrationStatus } from "./administration-inspection";
import { resolveProductionRelease } from "./production-release-preparation";
import { stagingIntentIdentity, type StagingAuthorization } from "./staging-authorization";
import {
  recordStagingProtocolStatement,
  stagingDeploymentSucceededStatement,
  stagingRecordStatement,
  stagingSchemaLevelStatement,
} from "./staging-release-repository";

type StagingEnvironment = {
  KEEPR_ENVIRONMENT?: string;
  CATALOGUE_DB: CatalogueStore;
  CATALOGUE_EXPORTS: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  CATALOGUE_D1_DATABASE_ID: string;
  D1_VERIFICATION_TOKEN: string;
};
export type PreparedStagingDeployment = {
  environment: "staging";
  authorization: StagingAuthorization;
  dispatch_inputs: Record<string, string>;
  prepared_plan_json: string;
  dispatch_digest: string;
  release_id: string;
};
type RecordRow = { operation: string; request_json: string; response_json: string };

/** Trust the production Worker's response over fixed HTTPS, never a client-supplied starting snapshot. */
async function productionAuthorization(
  request: Request,
  identity: Record<string, unknown>,
  at: string,
): Promise<StagingAuthorization> {
  const { releaseId, intentDigest } = stagingIntentIdentity(identity);
  const response = await fetch(stagingAudience, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
    headers: {
      authorization: request.headers.get("authorization") ?? "",
      "x-github-token": request.headers.get("x-github-token") ?? "",
      "content-type": "application/json",
    },
    body: canonicalJson(identity),
  });
  if (!response.ok)
    throw new AdministrationProblem(
      403,
      "staging_authorization_refused",
      "Production refused this exact staging workflow authorization.",
    );
  const authorization = (await response.json()) as StagingAuthorization;
  if (
    authorization.contract !== "card-keepr-staging-authorization@1" ||
    authorization.intent?.release_id !== releaseId ||
    authorization.intent_digest !== intentDigest ||
    (await sha256Text(canonicalJson(authorization.intent))) !== intentDigest ||
    !Number.isFinite(Date.parse(authorization.expires_at)) ||
    Date.parse(authorization.expires_at) <= Date.parse(at)
  )
    throw new AdministrationProblem(
      403,
      "staging_authorization_mismatch",
      "Production returned an invalid or expired staging authorization.",
    );
  return authorization;
}

export async function handleStagingDeployment(
  request: Request,
  env: StagingEnvironment,
  at = new Date().toISOString(),
): Promise<Response> {
  stagingOnly(request, env);
  const body = await readAdministrationBody(request);
  const authorization = await productionAuthorization(request, body, at);
  const { intent, intent_digest: digest } = authorization;
  const key = `staging-deployment:${intent.release_id}`;
  const prior = await stagingRecordStatement(env.CATALOGUE_DB, key).first<RecordRow>();
  if (prior !== null) {
    if (prior.operation !== "prepare_staging_deployment" || prior.request_json !== canonicalJson(authorization))
      conflict();
    return Response.json(JSON.parse(prior.response_json), { headers: { "cache-control": "no-store" } });
  }
  if (Date.parse(authorization.preparation_expires_at) <= Date.parse(at))
    throw new AdministrationProblem(
      409,
      "staging_preparation_expired",
      "The original staging preparation window expired; a new owner intent is required.",
    );
  const names = environmentNames("staging");
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
    "staging",
  );
  if (
    target === null ||
    target.d1_databases[0]!.id === disposableId ||
    target.d1_databases.some((database) =>
      intent.production_start.target.d1_databases.some((production) => production.id === database.id),
    )
  )
    throw new AdministrationProblem(500, "invalid_staging_target", "Staging must own distinct configured resources.");
  const status = await administrationStatus(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, at, target, false);
  const safe = status.safe_state as Record<string, unknown>;
  const preflight = status.release_preflight as Record<string, unknown>;
  const choices = {
    release_id: intent.release_id,
    idempotency_key: `staging-plan:${digest}`,
    expected_head_sha: intent.expected_head_sha,
    expected_actor: "github-actions[bot]",
    expected_current_revision_id: safe.current_revision_id,
    expected_migration_level: preflight.schema_migration_level,
    bootstrap: preflight.bootstrap,
    replacement_handoff: null,
  };
  // The original claim time owns the five-minute SQL preparation window, including a lost response/retry.
  const preview = await resolveProductionRelease(
    env.CATALOGUE_DB,
    env.CATALOGUE_EXPORTS,
    { ...choices, prepare: true },
    target,
    authorization.authorized_at,
  );
  const prepared = await resolveProductionRelease(
    env.CATALOGUE_DB,
    env.CATALOGUE_EXPORTS,
    { ...choices, confirmation: preview.confirmation },
    target,
    authorization.authorized_at,
  );
  const result = { ...prepared, environment: "staging", authorization };
  try {
    await recordStagingProtocolStatement(env.CATALOGUE_DB, {
      key,
      operation: "prepare_staging_deployment",
      request: canonicalJson(authorization),
      response: canonicalJson(result),
      at: authorization.authorized_at,
    }).run();
  } catch {
    const concurrent = await stagingRecordStatement(env.CATALOGUE_DB, key).first<RecordRow>();
    if (concurrent?.response_json !== canonicalJson(result)) conflict();
  }
  return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
}

export async function handleStagingOutcome(
  request: Request,
  env: StagingEnvironment,
  releaseId: string,
  at = new Date().toISOString(),
): Promise<Response> {
  stagingOnly(request, env);
  const body = await readAdministrationBody(request);
  if (Object.keys(body).sort().join("|") !== "intent_digest|outcome")
    throw new AdministrationProblem(
      422,
      "invalid_staging_outcome",
      "The exact intent digest and staging outcome are required.",
    );
  const authorization = await productionAuthorization(
    request,
    { release_id: releaseId, intent_digest: body.intent_digest },
    at,
  );
  let outcome: ReturnType<typeof validateStagingOutcome>;
  try {
    outcome = validateStagingOutcome(body.outcome, authorization.intent, authorization.intent_digest);
  } catch {
    throw new AdministrationProblem(
      422,
      "invalid_staging_outcome",
      "Staging outcome omitted or mismatched required evidence.",
    );
  }
  if (outcome.deployment.release_id !== releaseId) conflict();
  const preparation = await stagingRecordStatement(
    env.CATALOGUE_DB,
    `staging-deployment:${releaseId}`,
  ).first<RecordRow>();
  if (outcome.deployment.state !== "not_run") {
    const prepared = preparation === null ? null : (JSON.parse(preparation.response_json) as PreparedStagingDeployment);
    if (
      prepared?.dispatch_digest !== outcome.deployment.dispatch_digest ||
      canonicalJson(prepared.authorization) !== canonicalJson(authorization)
    )
      conflict();
    if (
      outcome.deployment.state === "succeeded" &&
      !(await stagingDeploymentSucceededStatement(
        env.CATALOGUE_DB,
        releaseId,
        prepared.prepared_plan_json,
        prepared.dispatch_digest,
      ).first())
    )
      throw new AdministrationProblem(
        409,
        "staging_deployment_not_succeeded",
        "The staging deployment has no exact successful activation and smoke outcome.",
      );
    if (outcome.deployment.state === "succeeded") {
      const schema = await stagingSchemaLevelStatement(env.CATALOGUE_DB).first<{ migration_level: number }>();
      if (schema?.migration_level !== outcome.migration.ending_level)
        throw new AdministrationProblem(
          409,
          "staging_migration_mismatch",
          "The deployed schema does not match the selected commit's migration rehearsal.",
        );
    }
  }
  const key = `staging-outcome:${releaseId}`;
  const result = { release_id: releaseId, authorization, outcome, recorded_at: at };
  const prior = await stagingRecordStatement(env.CATALOGUE_DB, key).first<RecordRow>();
  if (prior !== null) {
    const previous = JSON.parse(prior.response_json) as typeof result;
    if (
      prior.operation !== "staging_release_outcome" ||
      canonicalJson(previous.outcome) !== canonicalJson(outcome) ||
      canonicalJson(previous.authorization) !== canonicalJson(authorization)
    )
      conflict();
    return Response.json(previous, { headers: { "cache-control": "no-store" } });
  }
  try {
    await recordStagingProtocolStatement(env.CATALOGUE_DB, {
      key,
      operation: "staging_release_outcome",
      request: canonicalJson(authorization),
      response: canonicalJson(result),
      at,
    }).run();
  } catch {
    const concurrent = await stagingRecordStatement(env.CATALOGUE_DB, key).first<RecordRow>();
    const previous = concurrent === null ? null : (JSON.parse(concurrent.response_json) as typeof result);
    if (
      concurrent?.operation !== "staging_release_outcome" ||
      canonicalJson(previous?.outcome) !== canonicalJson(outcome) ||
      canonicalJson(previous?.authorization) !== canonicalJson(authorization)
    )
      conflict();
    return Response.json(previous, { headers: { "cache-control": "no-store" } });
  }
  return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
}

export async function showStagingDeployment(
  database: CatalogueStore,
  releaseId: string,
): Promise<Record<string, unknown>> {
  if (!isReleaseIdentity(releaseId))
    throw new AdministrationProblem(422, "invalid_staging_intent", "Invalid staging release identity.");
  const outcome = await stagingRecordStatement(database, `staging-outcome:${releaseId}`).first<RecordRow>();
  if (outcome?.operation === "staging_release_outcome")
    return JSON.parse(outcome.response_json) as Record<string, unknown>;
  const preparation = await stagingRecordStatement(database, `staging-deployment:${releaseId}`).first<RecordRow>();
  if (preparation === null || preparation.operation !== "prepare_staging_deployment")
    throw new AdministrationProblem(
      404,
      "staging_deployment_not_found",
      "This staging release has not prepared a deployment or recorded an outcome.",
    );
  const prepared = JSON.parse(preparation.response_json) as PreparedStagingDeployment;
  return { release_id: releaseId, authorization: prepared.authorization, deployment: prepared, outcome: null };
}
function stagingOnly(request: Request, env: StagingEnvironment): void {
  if (env.KEEPR_ENVIRONMENT !== "staging" || request.method !== "POST")
    throw new AdministrationProblem(404, "not_found", "Route not found.");
}
function conflict(): never {
  throw new AdministrationProblem(
    409,
    "staging_deployment_conflict",
    "The immutable staging preparation or outcome does not match this intent.",
  );
}
