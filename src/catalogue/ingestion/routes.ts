import { environmentNames } from "../../http/environment-target.mjs";
import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import {
  administrationResultStatus,
  assertOnlyFields,
  readAdministrationBody,
  requiredString,
} from "../../http/administration";
import { absoluteDocumentLinks } from "../../http/public-base";
import { type RouteContext, route } from "../../http/routes";
import { publicationBackupReservation, startOrObserveCatalogueBackupWorkflow } from "../backup-recovery";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { evidenceInspectionOptions, showEvidenceRun } from "../source-evidence";
import { resolveAdministrationTarget } from "./administration-target";
import { runGuardedCardSearchRepair } from "./card-search-repair-administration";
import {
  administrationStatus,
  inspectCandidate,
  observeHistoricalRunApproval,
  rejectRun,
  retryPublicationCleanup,
  retryRun,
  showRun,
} from "./ingestion";
import { resolveProductionRelease } from "./production-release-preparation";
import { advancePublicationExports } from "./publication-export-preparation";
import { runHasEvidencePlanStatement } from "./run-lifecycle-repository";

type Environment = Parameters<typeof evidenceInspectionOptions>[0] & {
  CATALOGUE_BACKUP_WORKFLOW: Parameters<typeof startOrObserveCatalogueBackupWorkflow>[1];
  CATALOGUE_D1_DATABASE_ID: string;
  CATALOGUE_DB: CatalogueStore;
  CATALOGUE_EXPORTS: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPOSABLE_D1_DATABASE_ID: string;
  KEEPR_ENVIRONMENT?: string;
  PRINTING_IMAGES: R2Bucket;
  BACKUPS: R2Bucket;
};
export type PublicationBackupWaiter = (
  initial: Record<string, unknown>,
  observe: () => Promise<Record<string, unknown>>,
) => Promise<void>;
type Context = RouteContext<Environment> & { observedAt: string; publicationBackupWaiter?: PublicationBackupWaiter };

export const ingestionRoutes = [
  route<Context>(
    "POST",
    "/v1/publications/:publication/export-preparation/advance",
    async ({ env, request }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["generation", "idempotency_key"]);
      return Response.json(
        await advancePublicationExports(
          env,
          params.publication!,
          Number(body.generation),
          requiredString(body, "idempotency_key"),
        ),
      );
    },
  ),
  route<Context>("POST", "/v1/production-releases", async ({ request, env, observedAt }) => {
    if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production")
      throw new AdministrationProblem(
        422,
        "production_target_required",
        "Production Release is unavailable on this environment.",
      );
    const body = await readAdministrationBody(request);
    return Response.json(
      await resolveProductionRelease(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, body, productionTarget(env), observedAt),
      {
        status: body.prepare === true ? 200 : 201,
      },
    );
  }),
  route<Context>("POST", "/v1/catalogue-search-materialization/repair", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["target_revision_id", "expected_current_revision_id", "idempotency_key"]);
    return Response.json(
      await runGuardedCardSearchRepair(
        env.CATALOGUE_DB,
        {
          target_revision_id: requiredString(body, "target_revision_id"),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      ),
    );
  }),
  route<Context>("GET", "/v1/status", async ({ env, observedAt, request }) => {
    const query = new URL(request.url).searchParams;
    const status = await administrationStatus(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      observedAt,
      productionTarget(env),
      query.size === 0,
    );
    return Response.json(
      query.size === 0 ? status : await resolveAdministrationTarget(env.CATALOGUE_DB, env.BACKUPS, status, query),
    );
  }),
  route<Context>("GET", "/v1/ingestion-runs/:run/candidate", async ({ env, observedAt }, params) => {
    return Response.json(await inspectCandidate(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, params.run!, observedAt));
  }),
  route<Context>(
    "POST",
    "/v1/ingestion-runs/:run/approval",
    async ({ request, env, requestId, base, observedAt, publicationBackupWaiter }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["candidate_digest", "expected_current_revision_id", "idempotency_key"]);
      const result = await observeHistoricalRunApproval(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        params.run!,
        {
          candidate_digest: requiredString(body, "candidate_digest"),
          expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      if (result.publication_outcome === "revision" && typeof result.resulting_revision_id === "string") {
        const reservation = await publicationBackupReservation(result.resulting_revision_id);
        const observe = async () =>
          (
            await startOrObserveCatalogueBackupWorkflow(
              env.CATALOGUE_DB,
              env.CATALOGUE_BACKUP_WORKFLOW,
              {
                expected_current_revision_id: result.resulting_revision_id as string,
                idempotency_key: reservation.idempotencyKey,
              },
              observedAt,
            )
          ).document;
        // Publication already committed its pending dispatch. An observation
        // outage must not turn that successful approval into an HTTP failure.
        try {
          const dispatched = await observe();
          await publicationBackupWaiter?.(dispatched, observe);
        } catch {
          console.error(
            JSON.stringify({
              contract: "card-keepr-operational-log@1",
              event: "workflow.failed",
              runtime: "ingestion",
              failure_code: "catalogue_backup_dispatch_observation_failed",
              request_id: requestId,
              workflow_step: "catalogue_backup_dispatch",
              catalogue_revision_id: result.resulting_revision_id,
              retry_classification: "retryable",
            }),
          );
        }
      }
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 200),
      });
    },
  ),
  route<Context>("POST", "/v1/ingestion-runs/:run/rejection", async ({ request, env, base, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["candidate_digest", "idempotency_key"]);
    const result = await rejectRun(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      params.run!,
      {
        candidate_digest: requiredString(body, "candidate_digest"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(absoluteDocumentLinks(result, base), {
      status: administrationResultStatus(result, 200),
    });
  }),
  route<Context>(
    "POST",
    "/v1/ingestion-runs/:run/retry",
    async ({ request, env, requestId, base, observedAt }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      const result = await retryRun(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        params.run!,
        {
          idempotency_key: requiredString(body, "idempotency_key"),
          operational_request_id: requestId,
        },
        observedAt,
      );
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 201),
      });
    },
  ),
  route<Context>(
    "POST",
    "/v1/ingestion-runs/:run/publication-cleanup",
    async ({ request, env, base, observedAt }, params) => {
      const body = await readAdministrationBody(request);
      assertOnlyFields(body, ["idempotency_key"]);
      const result = await retryPublicationCleanup(
        env.CATALOGUE_DB,
        env.CATALOGUE_EXPORTS,
        params.run!,
        {
          idempotency_key: requiredString(body, "idempotency_key"),
        },
        observedAt,
      );
      return Response.json(absoluteDocumentLinks(result, base), {
        status: administrationResultStatus(result, 200),
      });
    },
  ),
  route<Context>("GET", "/v1/ingestion-runs/:run", async ({ env, observedAt }, params) => {
    const runId = params.run!;
    if (await hasEvidencePlan(env.CATALOGUE_DB, runId)) {
      return Response.json(await showEvidenceRun(env.CATALOGUE_DB, runId, evidenceInspectionOptions(env)));
    }
    return Response.json(await showRun(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, runId, observedAt));
  }),
];

function productionTarget(env: Environment) {
  const names = environmentNames(env.KEEPR_ENVIRONMENT);
  const target = validatedEnvironmentTarget(
    {
      cloudflare_account_id: env.CLOUDFLARE_ACCOUNT_ID,
      worker_scripts: names.workers,
      d1_databases: [
        { name: names.catalogue, id: env.CATALOGUE_D1_DATABASE_ID },
        { name: names.disposable, id: env.DISPOSABLE_D1_DATABASE_ID },
      ],
      r2_buckets: names.buckets,
    },
    names.environment,
  );
  if (target === null)
    throw new AdministrationProblem(
      500,
      "invalid_administration_contract",
      "Production status did not expose exact Cloudflare target identities.",
    );
  return target;
}

async function hasEvidencePlan(database: CatalogueStore, runId: string): Promise<boolean> {
  const row = await runHasEvidencePlanStatement(database, runId).first<{ present: number }>();
  return row?.present === 1;
}
