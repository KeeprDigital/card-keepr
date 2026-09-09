import { expect, test } from "vitest";
import { publishReconciledErrataStatement } from "../../../src/catalogue/reconciliation/reconciliation-publication-repository";
import { catalogueStore } from "../../../src/catalogue/shared";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { coreGuardPublicationTime, markCoreGuardSibling } from "./query-helpers/core-guards";
import { erratumCount, publishedErratumTarget, removeErrataTargetGuards } from "./query-helpers/errata-guards";
import { collect, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();
test("Errata reject unknown Card and Printing targets and roll back sibling writes without triggers", async () => {
  const run = await collect("/reconciliation/product-release", "repository_errata_targets");
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "errata-repository-candidate",
  );
  const published = await approveNativeCandidate(candidate, "errata-repository-publication");
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  await removeErrataTargetGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const before = await coreGuardPublicationTime(database).first();
  for (const kind of ["card", "printing"] as const) {
    const id = `erratum_missing_${kind}`;
    await expect(
      database.batch([
        markCoreGuardSibling(database),
        publishReconciledErrataStatement(database, {
          revisionId,
          observedRevisionId: revisionId,
          payload: JSON.stringify([
            {
              id,
              game: "one-piece",
              target_type: kind,
              target_id: "missing",
              effective_from: "2026-09-01",
              official_wording: "corrected",
              corrected_value_json: JSON.stringify("corrected"),
            },
          ]),
        }),
      ]),
    ).rejects.toThrow("reconciled_erratum_target_invalid");
    expect(await erratumCount(testEnv.CATALOGUE_DB, id).first("count")).toBe(0);
    expect(await coreGuardPublicationTime(database).first()).toEqual(before);
    const targetId = await publishedErratumTarget(testEnv.CATALOGUE_DB, kind).first<string>("id");
    expect(targetId).not.toBeNull();
    const row = {
      id: `erratum_existing_${kind}`,
      game: "one-piece",
      target_type: kind,
      target_id: targetId,
      effective_from: "2026-09-01",
      official_wording: "corrected",
      corrected_value_json: JSON.stringify("corrected"),
    };
    await publishReconciledErrataStatement(database, {
      revisionId,
      observedRevisionId: revisionId,
      payload: JSON.stringify([row]),
    }).run();
    await expect(
      publishReconciledErrataStatement(database, {
        revisionId,
        observedRevisionId: revisionId,
        payload: JSON.stringify([{ ...row, game: "gundam" }]),
      }).run(),
    ).rejects.toThrow("reconciled_erratum_target_invalid");
  }
});
