import { route, type RouteContext } from "../../http/routes";
import {
  catalogueExportDeletionStatus,
  confirmCatalogueExportDeletion,
  prepareCatalogueExportDeletion,
  retryCatalogueExportDeletion,
} from "./catalogue-export-deletion";
import {
  readAdministrationBody,
  requiredString,
  assertOnlyFields,
  catalogueExportDeletionResultStatus,
} from "../shared";

type Environment = {
  CATALOGUE_DB: D1Database;
  CATALOGUE_EXPORTS: R2Bucket;
};
type Context = RouteContext<Environment> & { observedAt: string };

export const exportRoutes = [
  route<Context>("POST", "/v1/catalogue-export-deletion-plans", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["catalogue_revision_id", "manifest_digest", "expected_current_revision_id", "plan_id"]);
    const document = await prepareCatalogueExportDeletion(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      {
        catalogue_revision_id: requiredString(body, "catalogue_revision_id"),
        manifest_digest: requiredString(body, "manifest_digest"),
        expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
        plan_id: requiredString(body, "plan_id"),
      },
      observedAt,
    );
    return Response.json(document, { status: 201 });
  }),
  route<Context>("POST", "/v1/catalogue-export-deletions", async ({ request, env, observedAt }) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, [
      "plan_id",
      "plan_digest",
      "catalogue_revision_id",
      "manifest_digest",
      "expected_current_revision_id",
      "confirmation_revision_id",
      "deletion_id",
      "idempotency_key",
    ]);
    const document = await confirmCatalogueExportDeletion(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      {
        plan_id: requiredString(body, "plan_id"),
        plan_digest: requiredString(body, "plan_digest"),
        catalogue_revision_id: requiredString(body, "catalogue_revision_id"),
        manifest_digest: requiredString(body, "manifest_digest"),
        expected_current_revision_id: requiredString(body, "expected_current_revision_id"),
        confirmation_revision_id: requiredString(body, "confirmation_revision_id"),
        deletion_id: requiredString(body, "deletion_id"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(document, {
      status: catalogueExportDeletionResultStatus(document),
    });
  }),
  route<Context>("POST", "/v1/catalogue-export-deletions/:ref1/retry", async ({ request, env, observedAt }, params) => {
    const body = await readAdministrationBody(request);
    assertOnlyFields(body, ["object_set_digest", "idempotency_key"]);
    const document = await retryCatalogueExportDeletion(
      env.CATALOGUE_DB,
      env.CATALOGUE_EXPORTS,
      params.ref1!,
      {
        object_set_digest: requiredString(body, "object_set_digest"),
        idempotency_key: requiredString(body, "idempotency_key"),
      },
      observedAt,
    );
    return Response.json(document, {
      status: catalogueExportDeletionResultStatus(document),
    });
  }),
  route<Context>("GET", "/v1/catalogue-export-deletions/:ref1", async ({ env }, params) => {
    return Response.json(await catalogueExportDeletionStatus(env.CATALOGUE_DB, params.ref1!));
  }),
];
