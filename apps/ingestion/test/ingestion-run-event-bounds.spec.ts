import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore, createRunEventStatement, foldRunEvents } from "../../../src/catalogue/shared";
import { readEventFixtureDocument } from "./query-helpers/run-event-projection";
import {
  countEventAggregate,
  measureEventPayload,
  readEventPayloadMetadata,
  rejectAfterEventPayload,
  readEventBoundsSchemaLevel,
} from "./query-helpers/run-event-bounds";
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const candidate = JSON.stringify({ text: "🃏".repeat(300_000) });
const diagnostics = JSON.stringify([{ message: "é".repeat(300_000) }]);
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});
function birth(runId: string) {
  return createRunEventStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    runId,
    selectedGamesJson: '["one-piece"]',
    startedAt: "2026-09-04T00:00:00.000Z",
    linkedRunId: null,
    idempotencyKey: runId,
    state: "planning",
    candidateJson: candidate,
    diagnosticsJson: diagnostics,
  });
}
test("multibyte candidate and diagnostics retain exact bytes across bounded immutable chunks", async () => {
  const runId = "run_event_multibyte_bounds";
  await birth(runId).run();
  const rows = (
    await measureEventPayload(testEnv.CATALOGUE_DB, runId).all<{
      payload_kind: string;
      chunks: number;
      first_chunk: number;
      last_chunk: number;
      bytes: number;
      maximum_bytes: number;
    }>()
  ).results;
  expect(rows.map((row) => row.payload_kind)).toEqual(["candidate", "diagnostics"]);
  const metadata = JSON.parse(
    String(await readEventPayloadMetadata(testEnv.CATALOGUE_DB, runId).first("payloads")),
  ) as Record<string, { bytes: number; chunks: number }>;
  for (const row of rows) {
    expect(row.chunks).toBeGreaterThan(1);
    expect(row.first_chunk).toBe(0);
    expect(row.last_chunk).toBe(row.chunks - 1);
    expect(row.maximum_bytes).toBeLessThanOrEqual(524_288);
    expect(row.bytes).toBe(byteLength(row.payload_kind === "candidate" ? candidate : diagnostics));
    expect(metadata[row.payload_kind]).toEqual({ bytes: row.bytes, chunks: row.chunks });
  }
  const document = await readEventFixtureDocument(testEnv.CATALOGUE_DB, runId).first<{
    candidate_json: string;
    warnings_json: string;
  }>();
  expect(document?.candidate_json).toBe(candidate);
  expect(document?.warnings_json).toBe(diagnostics);
  expect((await foldRunEvents(catalogueStore(testEnv.CATALOGUE_DB), runId)).candidate_payload_event_sequence).toBe(1);
});
test("a late sibling failure rolls back the large payload together with its event and identity", async () => {
  const runId = "run_event_multibyte_rollback";
  await expect(
    catalogueStore(testEnv.CATALOGUE_DB).batch([birth(runId), rejectAfterEventPayload(testEnv.CATALOGUE_DB)]),
  ).rejects.toThrow("event_payload_rollback");
  expect(await countEventAggregate(testEnv.CATALOGUE_DB, runId).first()).toEqual({
    anchors: 0,
    projections: 0,
    events: 0,
    chunks: 0,
  });
});
test("event and payload expansion cannot hide beyond the 900 statement atomic limit", async () => {
  const runId = "run_event_payload_over_budget";
  await expect(
    catalogueStore(testEnv.CATALOGUE_DB).batch([
      ...Array.from({ length: 899 }, () => readEventBoundsSchemaLevel(testEnv.CATALOGUE_DB)),
      birth(runId),
    ]),
  ).rejects.toThrow("900-statement D1 budget after guard expansion");
  expect(await countEventAggregate(testEnv.CATALOGUE_DB, runId).first()).toEqual({
    anchors: 0,
    projections: 0,
    events: 0,
    chunks: 0,
  });
});
