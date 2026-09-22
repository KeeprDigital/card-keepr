import type { HttpRoute } from "../../http/openapi";
import {
  retainedRunRoute,
  retainedRunInspectionSchema,
  retainedCandidateRoute,
  retainedCandidateInspectionSchema,
  retainedApprovalRoute,
  retainedRejectionRoute,
  retainedRetryRoute,
  retainedCleanupRoute,
  retainedRunSchema,
  retainedAdministrationOperationSchema,
} from "./retained-run-http-contract";
import {
  administrationStatusRoute,
  resolveAdministrationTargetRoute,
  administrationTargetSchema,
  searchRepairRoute,
  searchRepairSchema,
} from "./maintenance-http-contract";
import { administrationStatusSchema } from "./administration-status-schema";
import { productionReleaseRoute, releaseConfirmationSchema } from "./production-http-contract";
import { releaseReceiptSchema } from "./release-http-schemas";
import {
  stagingReleaseRoute,
  stagingInspectionRoute,
  stagingDeploymentRoute,
  stagingReceiptSchema,
  stagingConfirmationSchema,
  stagingInspectionSchema,
  stagingDeploymentSchema,
} from "./staging-http-contract";
import { httpRoute, retainedWireValue } from "../../http/openapi";
import { advancePublicationExportsRoute, publicationExportPreparationSchema } from "./publication-http-contract";
import { environmentNames } from "../../http/environment-target.mjs";
import { validatedEnvironmentTarget } from "../../http/production-target.mjs";
import { administrationResultStatus } from "../../http/administration";
import { absoluteDocumentLinks } from "../../http/public-base";
import { type RouteContext } from "../../http/routes";
import {
  publicationBackupReservation,
  startOrObserveCatalogueBackupWorkflow,
  currentDisposableRestoreDatabaseId,
} from "../backup-recovery";
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
import { resolveStagingRelease, inspectStagingRelease } from "./staging-release";
import { showStagingDeployment } from "./staging-deployment";
import { advancePublicationExports } from "./publication-export-preparation";
import { runHasEvidencePlanStatement } from "./run-lifecycle-repository";

type Environment = Parameters<typeof evidenceInspectionOptions>[0] & {
  CATALOGUE_BACKUP_WORKFLOW: Parameters<typeof startOrObserveCatalogueBackupWorkflow>[1];
  CATALOGUE_D1_DATABASE_ID: string;
  CATALOGUE_DB: CatalogueStore;
  CATALOGUE_EXPORTS: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  DISPOSABLE_D1_DATABASE_ID: string;
  D1_VERIFICATION_TOKEN: string;
  KEEPR_ENVIRONMENT?: string;
  PRINTING_IMAGES: R2Bucket;
  BACKUPS: R2Bucket;
};
export type PublicationBackupWaiter = (
  initial: Record<string, unknown>,
  observe: () => Promise<Record<string, unknown>>,
) => Promise<void>;
type Context = RouteContext<Environment> & { observedAt: string; publicationBackupWaiter?: PublicationBackupWaiter };

export const ingestionRoutes: HttpRoute<Context>[] = [
  httpRoute<Context>()(stagingReleaseRoute, async (c) => {
    const { env, observedAt } = c.env;
    if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production")
      throw new AdministrationProblem(404, "not_found", "Route not found.");
    const body = c.req.valid("json");
    const result = await resolveStagingRelease(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      body,
      async () =>
        productionTarget(
          env,
          await currentDisposableRestoreDatabaseId(
            env.CLOUDFLARE_ACCOUNT_ID,
            env.D1_VERIFICATION_TOKEN,
            environmentNames().disposable,
          ),
        ),
      observedAt,
    );
    return body.prepare === true
      ? c.json(stagingConfirmationSchema.parse(result), 200, { "Cache-Control": "no-store" })
      : c.json(stagingReceiptSchema.parse(result), 201, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(stagingInspectionRoute, async (c) => {
    const { env } = c.env;
    if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production")
      throw new AdministrationProblem(404, "not_found", "Route not found.");
    return c.json(
      stagingInspectionSchema.parse(await inspectStagingRelease(env.CATALOGUE_DB, c.req.valid("param").release)),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(stagingDeploymentRoute, async (c) => {
    const { env } = c.env;
    if (env.KEEPR_ENVIRONMENT !== "staging") throw new AdministrationProblem(404, "not_found", "Route not found.");
    return c.json(
      stagingDeploymentSchema.parse(await showStagingDeployment(env.CATALOGUE_DB, c.req.valid("param").release)),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(advancePublicationExportsRoute, async (c) => {
    const input = c.req.valid("json");
    return c.json(
      publicationExportPreparationSchema.parse(
        await advancePublicationExports(
          c.env.env,
          c.req.valid("param").publication,
          input.generation,
          input.idempotency_key,
        ),
      ),
      200,
    );
  }),
  httpRoute<Context>()(productionReleaseRoute, async (c) => {
    const { env, observedAt } = c.env;
    if ((env.KEEPR_ENVIRONMENT ?? "production") !== "production")
      throw new AdministrationProblem(
        422,
        "production_target_required",
        "Production Release is unavailable on this environment.",
      );
    const input = c.req.valid("json");
    const result = await resolveProductionRelease(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      input,
      productionTarget(env),
      observedAt,
    );
    return input.prepare === true
      ? c.json(releaseConfirmationSchema.parse(result), 200, { "Cache-Control": "no-store" })
      : c.json(releaseReceiptSchema.parse(result), 201, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(searchRepairRoute, async (c) =>
    c.json(
      searchRepairSchema.parse(
        await runGuardedCardSearchRepair(c.env.env.CATALOGUE_DB, c.req.valid("json"), c.env.observedAt),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(administrationStatusRoute, async (c) =>
    c.json(
      retainedWireValue(
        administrationStatusSchema,
        await administrationStatus(
          c.env.env.CATALOGUE_DB,
          c.env.env.CATALOGUE_EXPORTS,
          c.env.observedAt,
          productionTarget(c.env.env),
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(resolveAdministrationTargetRoute, async (c) => {
    const { env, observedAt } = c.env;
    const _validated = c.req.valid("json");
    // Retained Curated targets can contain literal extension property names;
    // resolution must confirm the original JSON that the mutation will replay.
    const input = await c.req.json<typeof _validated>();
    const status = await administrationStatus(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      observedAt,
      productionTarget(env),
      false,
    );
    return c.json(
      administrationTargetSchema.parse(
        await resolveAdministrationTarget(env.CATALOGUE_DB, env.BACKUPS, status, input, {
          environment: env.KEEPR_ENVIRONMENT ?? "production",
          catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
        }),
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  }),
  httpRoute<Context>()(retainedCandidateRoute, async (c) =>
    c.json(
      retainedWireValue(
        retainedCandidateInspectionSchema,
        await inspectCandidate(
          c.env.env.CATALOGUE_DB,
          c.env.env.CATALOGUE_EXPORTS,
          c.req.valid("param").run,
          c.env.observedAt,
        ),
      ),
      200,
      { "Cache-Control": "no-store" },
    ),
  ),
  httpRoute<Context>()(retainedApprovalRoute, async (c) => {
    const { env, requestId, base, observedAt, publicationBackupWaiter } = c.env;
    const result = await observeHistoricalRunApproval(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      c.req.valid("param").run,
      c.req.valid("json"),
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
    const document = absoluteDocumentLinks(result, base);
    return administrationResultStatus(result, 200) === 202
      ? c.json(retainedWireValue(retainedAdministrationOperationSchema, document), 202, { "Cache-Control": "no-store" })
      : c.json(retainedWireValue(retainedRunSchema, document), 200, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(retainedRejectionRoute, async (c) => {
    const { env, base, observedAt } = c.env;
    const result = await rejectRun(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      c.req.valid("param").run,
      c.req.valid("json"),
      observedAt,
    );
    const document = absoluteDocumentLinks(result, base);
    return administrationResultStatus(result, 200) === 202
      ? c.json(retainedWireValue(retainedAdministrationOperationSchema, document), 202, { "Cache-Control": "no-store" })
      : c.json(retainedWireValue(retainedRunSchema, document), 200, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(retainedRetryRoute, async (c) => {
    const { env, base, observedAt, requestId } = c.env;
    const result = await retryRun(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      c.req.valid("param").run,
      { ...c.req.valid("json"), operational_request_id: requestId },
      observedAt,
    );
    const document = absoluteDocumentLinks(result, base);
    return administrationResultStatus(result, 201) === 202
      ? c.json(retainedWireValue(retainedAdministrationOperationSchema, document), 202, { "Cache-Control": "no-store" })
      : c.json(retainedWireValue(retainedRunSchema, document), 201, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(retainedCleanupRoute, async (c) => {
    const { env, base, observedAt } = c.env;
    const result = await retryPublicationCleanup(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      c.req.valid("param").run,
      c.req.valid("json"),
      observedAt,
    );
    const document = absoluteDocumentLinks(result, base);
    return administrationResultStatus(result, 200) === 202
      ? c.json(retainedWireValue(retainedAdministrationOperationSchema, document), 202, { "Cache-Control": "no-store" })
      : c.json(retainedWireValue(retainedRunSchema, document), 200, { "Cache-Control": "no-store" });
  }),
  httpRoute<Context>()(retainedRunRoute, async (c) => {
    const { env, observedAt } = c.env;
    const run = c.req.valid("param").run;
    const result = (await hasEvidencePlan(env.CATALOGUE_DB, run))
      ? await showEvidenceRun(env.CATALOGUE_DB, run, evidenceInspectionOptions(env))
      : await showRun(env.CATALOGUE_DB, env.CATALOGUE_EXPORTS, run, observedAt);
    return c.json(retainedWireValue(retainedRunInspectionSchema, result), 200, { "Cache-Control": "no-store" });
  }),
];

function productionTarget(env: Environment, disposableId = env.DISPOSABLE_D1_DATABASE_ID) {
  const names = environmentNames(env.KEEPR_ENVIRONMENT);
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
