import {
  verifyCompositionSnapshot,
  type CompositionSnapshotEvidence,
} from "../../../src/catalogue/backup-recovery/composition-verification";
import { catalogueStore } from "../../../src/catalogue/shared";
import { verifyCompositionArtifacts } from "../../../src/catalogue/backup-recovery/composition-artifacts";
import { retainedPublicComponent } from "./query-helpers/public-export-recovery";
import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic retained source evidence; exercises authenticated owner operations.
test("native backup consumes its reservation and rejects legacy-only simulated restore evidence", async () => {
  const source = await collect("/reconciliation/base", "atomic-source");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "atomic-candidate",
  });
  const id = requiredString(created.document, "id");
  let candidate = created.document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate.state).toBe("sealed");
  const intent = {
    candidate_id: id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: "catrev_spine_000",
    generation: candidate.generation,
    idempotency_key: "atomic-approval",
  };
  const approved = await post("/v1/publications", intent);
  expect(approved.response.status, JSON.stringify(approved.document)).toBe(202);
  expect(approved.document).toMatchObject({
    candidate_id: id,
    deadline: candidate.deadline,
    state: "approved",
    approval_scope: "whole_candidate",
  });
  expect(approved.document.id).not.toBe(id);
  expect(approved.document.id).not.toBe(source.id);
  expect((await post("/v1/publications", intent)).document).toEqual(approved.document);
  expect((await get(`/v1/publications/${approved.document.id}`)).document).toEqual(approved.document);
  expect((await post("/v1/publications", { ...intent, manifest_digest: "0".repeat(64) })).response.status).toBe(409);
  const preparationPath = `/v1/game-candidates/${id}/publication-preparation`;
  let preparation = (
    await post(preparationPath, {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "atomic-artifacts",
    })
  ).document;
  for (let unit = 0; preparation.state === "preparing" && unit < 250; unit++) {
    preparation = (
      await post(preparationPath, {
        manifest_digest: candidate.manifest_digest,
        generation: 0,
        sequence: preparation.sequence,
        idempotency_key: `atomic-artifacts-${unit}`,
      })
    ).document;
  }
  expect(preparation.state).toBe("verified");
  for (let unit = 0; unit < 250; unit++) {
    const prepared = await post(`/v1/publications/${approved.document.id}/export-preparation/advance`, {
      generation: 0,
      idempotency_key: `recovery-public-${unit}`,
    });
    expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(200);
    if (prepared.document.state !== "preparing") {
      expect(prepared.document.state).toBe("verified");
      break;
    }
  }
  const switched = await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 });
  expect(switched.response.status, JSON.stringify(switched.document)).toBe(200);
  expect(switched.document).toMatchObject({
    state: "published",
    deadline: candidate.deadline,
    backup_attempt_id: expect.any(String),
    resulting_revision_id: expect.any(String),
  });
  expect((await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 })).document).toEqual(
    switched.document,
  );
  expect((await get(`/v1/game-candidates/${id}`)).document.state).toBe("published");
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const component = await retainedPublicComponent(db, id).first<{ object_key: string; byte_length: number }>();
  expect(component).not.toBeNull();
  const key = component!.object_key;
  const original = await testEnv.CATALOGUE_EXPORTS.get(key);
  const bytes = await original!.arrayBuffer();
  const verifyArtifacts = () =>
    verifyCompositionArtifacts(
      db,
      testEnv.CATALOGUE_EXPORTS,
      testEnv.PRINTING_IMAGES,
      String(switched.document.resulting_revision_id),
    );
  await expect(verifyArtifacts()).resolves.toBeUndefined();
  try {
    await testEnv.CATALOGUE_EXPORTS.delete(key);
    await expect(verifyArtifacts()).rejects.toThrow(/artifact missing or truncated/);
    const corrupt = new Uint8Array(bytes.slice(0));
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await testEnv.CATALOGUE_EXPORTS.put(key, corrupt);
    await expect(verifyArtifacts()).rejects.toThrow(/artifact digest mismatch/);
  } finally {
    await testEnv.CATALOGUE_EXPORTS.put(key, bytes);
  }
  await expect(verifyArtifacts()).resolves.toBeUndefined();
  const backup = await post("/v1/backups", {
    expected_current_revision_id: switched.document.resulting_revision_id,
    idempotency_key: switched.document.backup_attempt_id,
  });
  expect(backup.response.status, JSON.stringify(backup.document)).toBe(202);
  let evidence = (await get(`/v1/backups/${switched.document.backup_attempt_id}`)).document;
  const backupDeadline = Date.now() + 15000;
  while (!["verified", "failed"].includes(String(evidence.state)) && Date.now() < backupDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    evidence = (await get(`/v1/backups/${switched.document.backup_attempt_id}`)).document;
  }
  expect(evidence.state, JSON.stringify(evidence)).toBe("verified");
  expect(evidence.publication_operation_id).toBe(approved.document.id);
  expect(evidence.publication_ingestion_run_id).toBe(source.id);
  expect(evidence.failure).toBeNull();
  const retained = await testEnv.BACKUPS.head(requiredString(evidence, "object_key"));
  const captured = await testEnv.BACKUPS.get(retained!.customMetadata!.snapshot_key!);
  const snapshot = await captured!.json<CompositionSnapshotEvidence>();
  // The former fixture supplied only legacy summary rows. Keep that adversarial
  // verification boundary explicit now that the default transport restores actual SQL.
  await expect(
    verifyCompositionSnapshot(
      async (request) =>
        request.kind === "foreign-keys"
          ? []
          : [
              {
                current_revision_id: switched.document.resulting_revision_id,
                schema_migration_level: snapshot.schema_migration_level,
                card_search_state: "ready",
                card_search_fts_tables: 1,
                missing_fts_rows: 0,
                invalid_api_documents: 0,
                invalid_curated_provenance: 0,
                invalid_audit_rows: 0,
              },
            ],
      snapshot,
    ),
  ).rejects.toThrow("Restored composition snapshot differs.");
});
