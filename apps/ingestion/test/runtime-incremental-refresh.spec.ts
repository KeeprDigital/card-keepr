import { catalogueStore } from "../../../src/catalogue/shared";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { OfficialSourceTransport } from "../src/official-source-transport";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  clearActiveRunForNextScenario,
  type CollectionDocument,
  createCollection,
  installRuntimeSuite,
  resumeCollection,
} from "./runtime-helpers";

installRuntimeSuite();

async function collectWithImages(key: string, imageUrls: readonly string[]): Promise<CollectionDocument> {
  const run = await createCollection(key, "https://incremental-refresh-official-source.invalid/sequence/root");
  const database = catalogueStore(env.CATALOGUE_DB);
  const storedRun = await requiredEvidenceRun(database, run.id);
  const root = (await pendingEvidenceRequests(database, run.id))[0];
  if (root === undefined) throw new Error("pending root request missing");
  await appendDiscoveredEvidenceRequests(
    database,
    storedRun,
    root,
    imageUrls.map((url) => ({ role: "image" as const, url, headers: { accept: "*/*" } })),
  );
  return resumeCollection(run.id);
}

// #389: a refresh reuses an unchanged Printing Image's retained bytes without
// a dispatch, records the skip explicitly, and still fetches a new URL.
test("a refresh skips unchanged image URLs explicitly and fetches only new ones", async () => {
  const unchanged = "https://incremental-refresh-official-source.invalid/png/unchanged";
  const added = "https://incremental-refresh-official-source.invalid/png/added";
  const first = await collectWithImages("incremental_refresh_first", [unchanged]);
  const firstImage = first.snapshots.find((snapshot) => snapshot.request.url === unchanged);
  expect(firstImage).toBeDefined();
  await clearActiveRunForNextScenario();

  const fetched: string[] = [];
  const transport = vi.spyOn(OfficialSourceTransport.prototype, "fetch").mockImplementation((request) => {
    fetched.push(request.url);
    return fetch(request);
  });
  let second: CollectionDocument;
  try {
    second = await collectWithImages("incremental_refresh_second", [unchanged, added]);
  } finally {
    transport.mockRestore();
  }
  await clearActiveRunForNextScenario();

  // The unchanged image made no Official Source request; the new one did.
  expect(fetched.sort()).toEqual([added, "https://incremental-refresh-official-source.invalid/sequence/root"].sort());
  const skippedSnapshot = second.snapshots.find((snapshot) => snapshot.request.url === unchanged);
  expect(skippedSnapshot).toMatchObject({
    reused_source_snapshot_id: firstImage!.id,
    retrieval: { retrieved_at: firstImage!.retrieval.retrieved_at },
    content: { digest: firstImage!.content.digest, object_key: firstImage!.content.object_key },
  });
  const skippedAttempt = second.diagnostics.find(
    (diagnostic) => diagnostic.id === skippedSnapshot!.retrieval.fetch_attempt_id,
  );
  expect(skippedAttempt).toMatchObject({
    outcome: "cache_revalidated",
    http_status: null,
    diagnostic: "source_image_unchanged_skipped",
    response_headers: {},
  });
  // Skips charge neither a dispatch nor bytes but stay counted in the receipt.
  const addedSnapshot = second.snapshots.find((snapshot) => snapshot.request.url === added)!;
  const rootSnapshot = second.snapshots.find((snapshot) => snapshot.request.url.endsWith("/root"))!;
  expect(second).toMatchObject({
    acquisition: {
      charged_dispatches: 2,
      charged_source_bytes: addedSnapshot.content.byte_length + rootSnapshot.content.byte_length,
      reserved_source_bytes: 0,
    },
    collection: {
      requests: { total: 3, by_state: { observed: 3 } },
      evidence: { skipped_request_count: 1, revalidated_attempt_count: 0, fetch_attempt_count: 3 },
    },
  });
}, 20_000);
