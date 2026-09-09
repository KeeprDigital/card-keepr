import { expect } from "vitest";
import { catalogueRoutes } from "../../../src/catalogue/read";
import { routeTable } from "../../../src/http/routes";
import { apiProblemResponse } from "../../api/src/problem";
import { cloudflareD1BackupProvider, createVerifiedCatalogueBackup } from "../../../src/catalogue/backup-recovery";
import { catalogueStore } from "../../../src/catalogue/shared";
import { get, post, requiredString, testEnv } from "./reconciliation-helpers";

export async function waitNativeState(path: string, terminal: readonly string[], timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  let result = await get(path);
  while (Date.now() < until) {
    expect(result.response.status, JSON.stringify(result.document)).toBe(200);
    if (terminal.includes(String(result.document.state))) return result.document;
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await get(path);
  }
  throw new Error(`Native operation remained pending: ${JSON.stringify(result.document)}`);
}

/** Public owner requests prepare real private artifacts but deliberately leave backup dispatch to the test. */
export async function approveNoChangeWithoutDispatch(candidate: Record<string, unknown>, key: string) {
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const prepared = await post(`${path}/start`, {
    manifest_digest: candidate.manifest_digest,
    generation: candidate.generation,
    sequence: 0,
    idempotency_key: `${key}-private`,
  });
  expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(202);
  expect((await waitNativeState(path, ["verified", "failed", "paused"])).state).toBe("verified");
  const intent = {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: key,
  };
  const approved = await post("/v1/publications", intent);
  expect(approved.response.status, JSON.stringify(approved.document)).toBe(202);
  return { operation: approved.document, intent };
}

/** Uses the actual fixture D1 export/import/query transport; only the optional artifact read is fault injected. */
export function verifyNativeBackup(
  id: string,
  revision: string,
  artifacts = testEnv.CATALOGUE_EXPORTS,
  retry?: { id: string; digest: string },
) {
  return createVerifiedCatalogueBackup(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: revision,
      idempotencyKey: id,
      observedAt: new Date().toISOString(),
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: testEnv.D1_EXPORT_TOKEN,
      verificationToken: testEnv.D1_VERIFICATION_TOKEN,
      ...(retry ? { failedAttemptId: retry.id, failedAttemptDigest: retry.digest } : {}),
    },
    cloudflareD1BackupProvider,
    { publicationArtifacts: artifacts, printingImages: testEnv.PRINTING_IMAGES },
  );
}

export async function assertVerifiedBackup(id: string) {
  const backup = await waitNativeState(`/v1/backups/${id}`, ["verified", "failed"]);
  expect(backup.state, JSON.stringify(backup)).toBe("verified");
  const retained = await testEnv.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshot = await testEnv.BACKUPS.get(retained!.customMetadata!.snapshot_key!);
  const document = await snapshot!.json<{ tables: { table: string; rows: number; sha256: string }[] }>();
  for (const table of [
    "game_accepted_candidates",
    "game_candidate_predecessors",
    "game_candidate_semantic_receipts",
    "catalogue_acceptance_head",
    "game_candidate_partitions",
  ])
    expect(document.tables.find((row) => row.table === table)).toMatchObject({
      rows: expect.any(Number),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  return backup;
}

/** Exercise the shipped public route and problem serializer against the same native database. */
export async function readNativeCards(revision: string) {
  const request = new Request(`https://catalogue.example/v1/cards?game=one-piece&revision=${revision}`);
  try {
    return (await routeTable(catalogueRoutes)("GET", "/v1/cards", {
      request,
      env: { ...testEnv, CATALOGUE_DB: catalogueStore(testEnv.CATALOGUE_DB) },
      requestId: "native-retention-proof",
      base: { origin: "https://catalogue.example", basePath: "" },
    }))!;
  } catch (error) {
    return apiProblemResponse(error, "native-retention-proof");
  }
}
