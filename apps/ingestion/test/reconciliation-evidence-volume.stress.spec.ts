import { expect, test } from "vitest";
import { collectRequests, get, installReconciliationSuite, post, requiredString } from "./reconciliation-helpers";

installReconciliationSuite();

test("individually valid Source documents above 32 MiB in total seal into bounded game partitions", async () => {
  const run = await collectRequests(
    Array.from({ length: 9 }, (_, index) => ({ id: `volume-${index}`, scenario: `bounded-evidence-volume-${index}` })),
    "bounded-evidence-volume",
  );
  const snapshots = run.document.snapshots as { content: { byte_length: number } }[];
  expect(snapshots).toHaveLength(9);
  expect(snapshots.every(({ content }) => content.byte_length < 16 * 1024 * 1024)).toBe(true);
  expect(snapshots.reduce((bytes, { content }) => bytes + content.byte_length, 0)).toBeGreaterThan(32 * 1024 * 1024);
  const started = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "bounded-evidence-volume-reconcile",
  });
  expect(started.response.status).toBe(202);
  const deadline = Date.now() + 90_000;
  let status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  while (status.document.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  }
  expect(status.document).toMatchObject({ state: "sealed", generation: 0 });
  const candidates = status.document.candidates as { id: string; supported_game: string }[];
  expect(candidates).toHaveLength(1);
  expect(candidates[0]!.supported_game).toBe("one-piece");
  const manifest = await get(`/v1/game-candidates/${candidates[0]!.id}/partitions`);
  expect(manifest.response.status).toBe(200);
  const partitions = manifest.document.partitions as { ordinal: number; kind: string; byte_length: number }[];
  expect(partitions.every((partition) => partition.byte_length <= 524_288)).toBe(true);
  const counts = { cards: 0, printings: 0 };
  for (const partition of partitions) {
    if (partition.kind !== "cards" && partition.kind !== "printings") continue;
    const page = await get(`/v1/game-candidates/${candidates[0]!.id}/partitions/${partition.ordinal}`);
    expect(page.response.status).toBe(200);
    expect(new TextEncoder().encode(JSON.stringify(page.document)).byteLength).toBeLessThan(1_048_576);
    counts[partition.kind] += (page.document.records as unknown[]).length;
  }
  expect(counts).toEqual({ cards: 9, printings: 9 });
}, 120_000);
