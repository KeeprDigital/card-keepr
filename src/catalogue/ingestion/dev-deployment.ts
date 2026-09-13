import { readAdministrationBody } from "../../http/administration";
import { verifyDevWorkflow } from "../../http/dev-workflow-identity.mjs";
import { environmentNames } from "../../http/environment-target.mjs";
import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import { currentDisposableRestoreDatabaseId } from "../backup-recovery";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { administrationStatus } from "./administration-inspection";
import { resolveProductionRelease } from "./production-release-preparation";
import { preparedProductionReleaseStatement } from "./production-release-repository";

/** Dev-only workflow identity grants one exact preparation, never administration access. */
export async function handleDevDeployment(
  request: Request,
  env: {
    KEEPR_ENVIRONMENT?: string;
    CATALOGUE_DB: CatalogueStore;
    CATALOGUE_EXPORTS: R2Bucket;
    CLOUDFLARE_ACCOUNT_ID: string;
    CATALOGUE_D1_DATABASE_ID: string;
    D1_VERIFICATION_TOKEN: string;
  },
): Promise<Response> {
  if (env.KEEPR_ENVIRONMENT !== "dev" || request.method !== "POST")
    throw new AdministrationProblem(404, "not_found", "Route not found.");
  const intent = await readAdministrationBody(request);
  let identity: Awaited<ReturnType<typeof verifyDevWorkflow>>;
  try {
    identity = await verifyDevWorkflow(
      request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "",
      request.headers.get("x-github-token") ?? "",
      intent,
    );
  } catch {
    throw new AdministrationProblem(
      403,
      "invalid_dev_workflow_attestation",
      "Dev workflow identity or exact-commit CI could not be verified.",
    );
  }
  const names = environmentNames("dev");
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
    "dev",
  );
  if (target === null || target.d1_databases[0]!.id === target.d1_databases[1]!.id)
    throw new AdministrationProblem(500, "invalid_dev_target", "Dev resources are not configured.");
  const idempotencyKey = `dev:${identity.runId}:${identity.runAttempt}`;
  // A run attempt can prepare once. A retry needs a new authenticated run attempt;
  // existing canonical lease/state guards still prohibit overlapping mutation.
  if (await preparedProductionReleaseStatement(env.CATALOGUE_DB, idempotencyKey).first())
    throw new AdministrationProblem(
      409,
      "dev_intent_replayed",
      "This dev workflow attempt already prepared a deployment.",
    );
  const observedAt = new Date().toISOString();
  const status = await administrationStatus(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, observedAt, target, false);
  const safe = status.safe_state as Record<string, unknown>;
  const preflight = status.release_preflight as Record<string, unknown>;
  const choices = {
    release_id: `dev-${identity.runId}-${identity.runAttempt}`,
    idempotency_key: idempotencyKey,
    expected_head_sha: identity.headSha,
    expected_actor: "github-actions[bot]",
    expected_current_revision_id: safe.current_revision_id,
    expected_migration_level: preflight.schema_migration_level,
    bootstrap: preflight.bootstrap,
    replacement_handoff: null,
  };
  const preview = await resolveProductionRelease(
    env.CATALOGUE_DB,
    env.CATALOGUE_EXPORTS,
    { ...choices, prepare: true },
    target,
    observedAt,
  );
  const prepared = await resolveProductionRelease(
    env.CATALOGUE_DB,
    env.CATALOGUE_EXPORTS,
    { ...choices, confirmation: preview.confirmation },
    target,
    observedAt,
  );
  return Response.json(
    {
      ...prepared,
      environment: "dev",
      workflow_run_id: identity.runId,
      authorization_expires_at: new Date(Date.parse(observedAt) + 5 * 60_000).toISOString(),
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}
