import ingestionWorker from "../../test/support/ingestion-worker";
export * from "../../test/support/ingestion-worker";
import { collectFixtureEvidence, injectFixtureEvidencePlan } from "../../test/support/fixture-evidence-plan";
import { nativePreparationDriver } from "../../apps/ingestion/test/native-preparation-driver";
import { catalogueEnvironment } from "../../src/catalogue/shared";
import { createGameReconciliation } from "../../src/catalogue/reconciliation/game-reconciliation";
import { inspectGameCandidate } from "../../src/catalogue/reconciliation/game-candidate";
import { startPublicationPreparation } from "../../src/catalogue/reconciliation/publication-preparation-dispatch";
import { inspectPublication, startGamePublication } from "../../src/catalogue/reconciliation/game-publication";
import { catalogueBackupAttemptStatus } from "../../src/catalogue/backup-recovery";

/** Scoped fixture setup: real collection, publication and SQL restore, with
 * scheduling controlled by the shared native owner driver. The tested backup
 * and recovery operations below always use the shipped Worker and bindings. */
export default {
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    if (new URL(request.url).pathname !== "/acceptance/published-backup-source")
      return ingestionWorker.fetch(request, env, context);
    if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${env.ADMINISTRATION_KEY}`)
      return new Response(null, { status: 403 });
    const { label, predecessor } = await request.json<{ label: "first" | "later"; predecessor: string }>();
    if (!["first", "later"].includes(label)) throw new Error("Unknown backup owner fixture");
    const run = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "one-piece", source_lineage: "one-piece-en", adapter_version: "fixture-one-piece-json@3",
      requests: [{ id: "one-piece-en:discovery", url: `https://official-source.invalid/reconciliation/base?revision=${label}` }],
      idempotency_key: `owner-source-${label}`,
    });
    await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, env.OFFICIAL_SOURCE_TRANSPORT, String(run.id));
    const driver = nativePreparationDriver(env, "native-owner");
    const composition = catalogueEnvironment(driver.environment);
    const at = new Date().toISOString();
    const prepared = await createGameReconciliation(composition.CATALOGUE_DB, composition.RECONCILIATION_WORKFLOW, {
      ingestion_run_id: String(run.id), supported_game: "one-piece", expected_game_revision_id: predecessor,
      idempotency_key: `owner-candidate-${label}`,
    }, at);
    await driver.drain();
    const candidate = await inspectGameCandidate(composition.CATALOGUE_DB, String(prepared.document.id));
    if (candidate.state !== "sealed") throw new Error("Native backup owner candidate did not seal");
    const candidateId = String(candidate.id), manifest = String(candidate.manifest_digest), generation = Number(candidate.generation);
    await startPublicationPreparation(composition, candidateId, {
      manifest_digest: manifest, generation, sequence: 0, idempotency_key: `owner-artifacts-${label}`,
    }, at);
    await driver.drain();
    const approval = await startGamePublication(composition, {
      candidate_id: candidateId, manifest_digest: manifest, generation, expected_game_revision_id: predecessor,
      idempotency_key: `owner-publication-${label}`,
    }, at);
    await driver.drain();
    const published = await inspectPublication(composition.CATALOGUE_DB, approval.id);
    const backup = await catalogueBackupAttemptStatus(composition.CATALOGUE_DB, String(published.backup_attempt_id));
    if (published.state !== "published" || backup.state !== "verified")
      throw new Error(`Native backup owner fixture did not complete: ${JSON.stringify({ published, backup })}`);
    return Response.json({ published, candidate, backup });
  },
};
