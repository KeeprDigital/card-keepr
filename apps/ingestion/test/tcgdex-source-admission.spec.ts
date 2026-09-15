import { expect, test } from "vitest";
import englishBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/english-sets.body?raw";
import pocketBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/pocket-series.body?raw";
import setBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/set-base1.body?raw";
import cardBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/card-base1-98.body?raw";
import imageDataUrl from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/image-base1-98.body?url&inline";
import { type CatalogueStore, catalogueStore, canonicalJson, sha256, sha256Text } from "../../../src/catalogue/shared";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { requiredEvidenceRun, pendingEvidenceRequests } from "../../../src/catalogue/source-evidence";
import {
  collect,
  requiredString,
  get,
  post,
  installReconciliationSuite,
  postFixtureEvidence,
  testEnv,
} from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeCandidate, prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { reviewProposals, reviewPrivateReferences, reviewAllocations } from "./query-helpers/source-admission-evidence";
import { retainedTcgdexContexts } from "./query-helpers/tcgdex-retained-graph";
import * as reviewQueries from "./query-helpers/source-admission-evidence";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import {
  parseSourceAdmissionEvidence,
  retainSourceAdmissionEvidence,
} from "../../../src/catalogue/reconciliation/source-admission-evidence";
import { verifiedRetainedPrintingImage } from "../../../src/catalogue/reconciliation/reconciliation-images";
import type { SnapshotRow } from "../../../src/catalogue/source-evidence/source-evidence-repository-types";
import { decideEntityProposal, inspectEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { failedReconciliationWorkflowStatement } from "../../../src/catalogue/reconciliation/reconciliation-state-repository";

installReconciliationSuite({ directPreparation: true });

async function collectedRecord(key: string) {
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const bodies = new Map([
    ["https://api.tcgdex.net/v2/en/sets", englishBody],
    ["https://api.tcgdex.net/v2/en/series/tcgp", pocketBody],
    ["https://api.tcgdex.net/v2/en/sets/base1", setBody],
    ["https://api.tcgdex.net/v2/en/cards/base1-98", cardBody],
  ]);
  expect(imageDataUrl).toMatch(/^data:[^,]*;base64,/u);
  const image = Uint8Array.from(atob(imageDataUrl.slice(imageDataUrl.indexOf(",") + 1)), (character) =>
    character.charCodeAt(0),
  );
  expect(await sha256(image)).toBe("b37b463cd43a7f6eeac0c9619f2e950d50b8984bf4436f134c48ff8167460830");
  const imageUrl = "https://assets.tcgdex.net/en/base/base1/98/high.png";
  const fetched: string[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL) {
      const url = new Request(input).url;
      fetched.push(url);
      if (url === imageUrl) return new Response(image, { headers: { "content-type": "image/png" } });
      const body = bodies.get(url);
      if (body === undefined) throw new Error(`No retained fixture body for ${url}`);
      return new Response(body, { headers: { "content-type": "application/json" } });
    },
  } as Fetcher;
  const started = await postFixtureEvidence({
    supported_game: "pokemon",
    source_lineage: "tcgdex-pokemon-en",
    adapter_version: "fixture-tcgdex-review-record@1",
    idempotency_key: key,
    requests: [
      {
        id: "tcgdex-pokemon-en:english-set-inventory",
        url: "https://api.tcgdex.net/v2/en/sets",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const runId = String(started.document.id);
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, runId);
  expect((await requiredEvidenceRun(db, runId)).state).toBe("parsing");
  expect(await pendingEvidenceRequests(db, runId)).toEqual([]);
  expect(fetched).toEqual([...bodies.keys(), imageUrl]);
  const contexts = (
    await retainedTcgdexContexts(testEnv.CATALOGUE_DB)
      .bind(runId)
      .all<{ dependency_count: number; observation_set_id: string; snapshot_id: string }>()
  ).results;
  expect(contexts.map((context) => context.dependency_count)).toEqual([0, 1, 2, 3]);
  return { db, runId, imageUrl, contexts };
}

test("a completed single-record fixture retains its source image through proposal response loss, replay, owner decision and cleanup with zero canonical contribution", async () => {
  const { db, runId, imageUrl, contexts } = await collectedRecord("pokemon-record-proposal-fixture");
  const leaf = contexts[3]!;
  const wrapped = (await readSourceObservation(db, leaf.observation_set_id, 0)) as { id: string; value: unknown };
  const review = parseSourceAdmissionEvidence(wrapped.value, requiredSourceAdapter("fixture-tcgdex-review-record@1"));
  if (review.game !== "pokemon") throw new Error("Expected retained Pokémon review evidence");
  const source = {
    sourceObservationId: wrapped.id,
    sourceObservationSetId: leaf.observation_set_id,
    sourceSnapshotId: leaf.snapshot_id,
  };
  const imageSnapshot = await reviewQueries.reviewImageSnapshots(db).bind(runId, "image").first<SnapshotRow>();
  expect(imageSnapshot).not.toBeNull();
  const images = new Map([
    [
      imageUrl,
      {
        ...(await verifiedRetainedPrintingImage(testEnv.EVIDENCE_OBJECTS, imageSnapshot!)),
        content_object_key: imageSnapshot!.content_object_key,
      },
    ],
  ]);
  // An active preparation fixture isolates acknowledgement loss in the shared
  // proposal transaction. The ordinary native preparation runs after replay.
  const preparation = "pokemon-record-interrupted-preparation",
    at = new Date().toISOString();
  await db.batch([
    reviewQueries
      .insertReviewPreparation(db)
      .bind(
        preparation,
        runId,
        "pokemon",
        "preparing",
        at,
        new Date(Date.parse(at) + 86400000).toISOString(),
        "{}",
        0,
        0,
        0,
      ),
    reviewQueries.insertReviewSlot(db).bind("pokemon", preparation, runId),
  ]);
  let responseLost = false;
  const failing: CatalogueStore = catalogueStore(
    new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!responseLost && (await reviewQueries.reviewEvidencePins(db).bind(runId).all()).results.length === 1) {
              responseLost = true;
              throw new Error("lost Pokemon proposal acknowledgement");
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  await expect(retainSourceAdmissionEvidence(failing, preparation, review, source, images, at)).rejects.toMatchObject({
    name: "ReconciliationDocumentStorageError",
    cause: { message: "lost Pokemon proposal acknowledgement" },
  });
  expect(responseLost).toBe(true);
  const committed = (await reviewProposals(db).bind("tcgdex-pokemon-en").all()).results;
  expect(committed).toHaveLength(1);
  const resumed = await retainSourceAdmissionEvidence(db, preparation, review, source, images, at);
  expect(resumed.proposalIds).toEqual([committed[0]!.id]);
  expect(await retainSourceAdmissionEvidence(db, preparation, review, source, images, at)).toEqual(resumed);
  expect((await reviewProposals(db).bind("tcgdex-pokemon-en").all()).results).toEqual(committed);
  const conflicting = {
    ...review,
    appearance_evidence: {
      images: review.appearance_evidence.images.map((image) => ({ ...image, content_sha256: "0".repeat(64) })),
    },
  };
  await expect(retainSourceAdmissionEvidence(db, preparation, conflicting, source, images, at)).rejects.toThrow(
    "image digest conflicts",
  );
  await db.batch([
    reviewQueries.abandonReviewPreparation(db).bind("abandoned", preparation),
    reviewQueries.releaseReviewSlot(db).bind(preparation),
  ]);
  const proposals = (
    await reviewProposals(db)
      .bind("tcgdex-pokemon-en")
      .all<{ id: string; reference: string; content_json: string; evidence_json: string }>()
  ).results;
  expect(proposals).toHaveLength(1);
  const proposal = proposals[0]!;
  const reference = '["base1-98",{"kind":"unresolved_record"}]';
  expect(proposal.reference).toBe(reference);
  expect(proposal.id).toBe(`proposal_${await sha256Text(canonicalJson(["tcgdex-pokemon-en", reference]))}`);
  expect(proposal.content_json).toBe('{"game":"pokemon","locator":"base1-98","target":{"kind":"unresolved_record"}}');
  const evidence = JSON.parse(proposal.evidence_json);
  expect(evidence).not.toHaveProperty("physical_images");
  expect(evidence).toMatchObject({
    source_membership: { set_id: "base1", local_id: "98" },
    source_images: [
      {
        association: "source_record",
        role: "front",
        source_url: imageUrl,
        content_sha256: "b37b463cd43a7f6eeac0c9619f2e950d50b8984bf4436f134c48ff8167460830",
      },
    ],
  });
  const references = (
    await reviewPrivateReferences(db).bind("entity_proposal", proposal.id).all<{ object_key: string }>()
  ).results;
  expect(references).toHaveLength(1);
  const object = await testEnv.EVIDENCE_OBJECTS.get(references[0]!.object_key);
  expect(object).not.toBeNull();
  expect(await sha256(new Uint8Array(await object!.arrayBuffer()))).toBe(
    "b37b463cd43a7f6eeac0c9619f2e950d50b8984bf4436f134c48ff8167460830",
  );
  expect((await get(`/v1/entity-proposals/${proposal.id}`)).document).toMatchObject({
    status: "unresolved",
    generation: 0,
  });
  expect((await reviewProposals(db).bind("tcgdex-pokemon-en").all()).results).toEqual(committed);
  // The collected fixture is now unused terminal evidence. Use a real guarded
  // failure event to exercise cleanup; the partial production graph stays open.
  await failedReconciliationWorkflowStatement(db, {
    terminalAt: at,
    failureCode: "fixture_preparation_abandoned",
    diagnosticsJson: "{}",
    runId,
  }).run();
  await reviewQueries.releaseReviewCollection(db).bind(runId).run();
  const decision = {
    action: "reject",
    expected_generation: "0",
    rationale: "Preserve unresolved source claims without admitting a treatment",
    idempotency_key: "pokemon-record-reject",
  };
  expect(await decideEntityProposal(db, proposal.id, decision, at)).toMatchObject({
    status: "rejected",
    generation: 1,
  });
  expect(await decideEntityProposal(db, proposal.id, decision, at)).toMatchObject({
    status: "rejected",
    generation: 1,
  });
  const cleanupAt = new Date(Date.parse(at) + 31 * 86400000).toISOString();
  let cleanup = await beginEvidenceCleanup(db, runId, "pokemon-record-cleanup", 30, cleanupAt);
  for (let unit = 0; unit < 20 && cleanup.state !== "completed"; unit++)
    cleanup = await advanceEvidenceCleanup(db, testEnv.EVIDENCE_OBJECTS, cleanup.id, cleanupAt);
  expect(cleanup.state).toBe("completed");
  for (const context of contexts) {
    const retained = await get(`/v1/source-snapshots/${context.snapshot_id}/content`);
    expect(retained.response.status).toBe(200);
  }
  const retainedImage = await testEnv.EVIDENCE_OBJECTS.get(references[0]!.object_key);
  expect(retainedImage).not.toBeNull();
  expect(await sha256(new Uint8Array(await retainedImage!.arrayBuffer()))).toBe(
    "b37b463cd43a7f6eeac0c9619f2e950d50b8984bf4436f134c48ff8167460830",
  );
  expect(await inspectEntityProposal(db, proposal.id)).toMatchObject({ status: "rejected", generation: 1 });
  expect((await reviewAllocations(db).all()).results).toEqual([]);
  // A later complete retained capture appends evidence without rewriting the
  // proposal's original content/evidence/request JSON or owner decision.
  const refreshed = await collectedRecord("pokemon-record-refresh-fixture");
  const candidate = await prepareNativeEvidence({
    runId: refreshed.runId,
    game: "pokemon",
    predecessor: "catrev_spine_000",
    key: "pokemon-record-refreshed-candidate",
  });
  const records = await nativeCandidateRecords(String(candidate.id), ["cards", "printings"]);
  // The verified paginated manifest has no Card or Printing partitions.
  expect(records).toEqual({});
  expect((await reviewAllocations(db).all()).results).toEqual([]);
  expect((await reviewProposals(db).bind("tcgdex-pokemon-en").all()).results).toEqual(committed);
  expect(await inspectEntityProposal(db, proposal.id)).toMatchObject({ status: "rejected", generation: 1 });
  expect((await reviewQueries.reviewEvidencePins(db).bind(refreshed.runId).all()).results).toHaveLength(1);
  expect((await reviewPrivateReferences(db).bind("entity_proposal", proposal.id).all()).results).toHaveLength(2);
  const abandoned = await post(`/v1/game-candidates/${candidate.id}/abandon`, {
    generation: candidate.generation,
    idempotency_key: "pokemon-refreshed-record-abandon",
  });
  expect(abandoned.response.status).toBe(202);
  // Publish an unrelated established control so ordinary backup performs actual
  // SQL export/import with both retained Pokémon captures and their image pins.
  const controlRun = await collect("/reconciliation/repeatable", "pokemon-record-backup-control");
  const controlCandidate = await prepareNativeCandidate(
    controlRun.id,
    "one-piece",
    "catrev_spine_000",
    "pokemon-record-backup-candidate",
  );
  const published = await approveNativeCandidate(controlCandidate, "pokemon-record-backup-publication");
  const backup = (await get(`/v1/backups/${requiredString(published.document, "backup_attempt_id")}`)).document;
  expect(backup.state).toBe("verified");
  const backupObject = await testEnv.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshotObject = await testEnv.BACKUPS.get(backupObject!.customMetadata!.snapshot_key!);
  const snapshot = await snapshotObject!.json<Record<string, unknown>>();
  expect(snapshot.parent_context_evidence).toMatchObject({
    objects: 12,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(snapshot.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: "source_parse_contexts", rows: 8 }),
      expect.objectContaining({ table: "source_parse_dependencies", rows: 12 }),
    ]),
  );
});
