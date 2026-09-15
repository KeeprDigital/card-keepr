import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import reminder from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/manifest-reminder.json?raw";
import control from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import reversible from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json?raw";
import art from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/art-chillerpillar.json?raw";
import { catalogueStore, type CatalogueStore } from "../../../src/catalogue/shared";
import { parseCapturedRequest, requiredEvidenceRun } from "../../../src/catalogue/source-evidence";
import { currentPause } from "../../../src/catalogue/source-evidence/source-evidence-repository";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { archiveParseProgress } from "../../../src/catalogue/source-evidence/source-archive-repository";
import { sourceRecordProgress } from "../../../src/catalogue/source-evidence/source-record-repository";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import { archiveRecoveryFence } from "./query-helpers/source-archive-fences";
import * as queries from "./query-helpers/source-archive-replay";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedArchive, version } from "./source-archive-fixture";

installRuntimeSuite();

const archiveBytes = (records: string[]) =>
  new TextEncoder().encode(records.map((raw) => (raw.endsWith("\n") ? raw : `${raw}\n`)).join(""));

async function retainedRows(db: CatalogueStore, snapshot: string, set: string) {
  const rows = queries.archiveReplayRows(db);
  return {
    operations: (await rows.operations.bind(snapshot).all()).results,
    sets: (await rows.sets.bind(snapshot).all()).results,
    records: (await rows.records.bind(set).all()).results,
    auxiliary: (await rows.auxiliary.bind(set).all()).results,
    archiveCursor: await archiveParseProgress(db, set).first(),
    recordCursor: await sourceRecordProgress(db, set).first(),
  };
}

function observedBucket() {
  const calls: string[] = [];
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { bucket, calls };
}

test("sealed archive replay retains semantic state while its guarded batch changes no rows", async () => {
  const { db, run, request, snapshot } = await seedArchive(
    "archive-sealed-replay-invariants",
    false,
    archiveBytes([reminder, control]),
  );
  const intent = { intent: "collection" as const, idempotencyKey: `${run.id}:${request.request_id}` };
  const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent);
  if ("kind" in sealed) throw new Error("Two-record archive should seal in one callback.");
  expect(sealed.observation_count).toBe(2);
  const before = await retainedRows(db, snapshot.id, sealed.id);
  expect(before.operations).toHaveLength(1);
  expect(before.sets).toHaveLength(1);
  expect(before.records).toHaveLength(2);
  expect(before.archiveCursor).toMatchObject({ next_record: 2, next_variant: 0, discovery_ordinal: 0 });
  expect(before.recordCursor).toMatchObject({ sealed: 1, next_ordinal: 2 });
  const manifest = await env.EVIDENCE_OBJECTS.get(sealed.content_object_key);
  if (!manifest) throw new Error("Sealed manifest missing.");
  const bytes = await manifest.arrayBuffer();
  const batches: { changes: number; rowsWritten: number }[][] = [];
  let attempts = 0;
  const measuredDb = catalogueStore(
    new Proxy(env.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            attempts++;
            const results = await target.batch(statements);
            batches.push(results.map(({ meta }) => ({ changes: meta.changes, rowsWritten: meta.rows_written })));
            return results;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const observed = observedBucket();
  expect(await parseSnapshotBatch(measuredDb, observed.bucket, snapshot.id, version, intent)).toEqual(sealed);
  // A batch request is not a row change: replay still checks authority and
  // retries creation of the same deterministic operation with INSERT OR IGNORE.
  expect(attempts).toBe(1);
  expect(batches).toEqual([
    [
      { changes: 0, rowsWritten: 0 },
      { changes: 0, rowsWritten: 0 },
    ],
  ]);
  expect(observed.calls).toEqual([]);
  expect(await retainedRows(db, snapshot.id, sealed.id)).toEqual(before);
  expect(await (await env.EVIDENCE_OBJECTS.get(sealed.content_object_key))!.arrayBuffer()).toEqual(bytes);

  await expect(
    parseSnapshotBatch(measuredDb, observed.bucket, snapshot.id, version, {
      ...intent,
      workflowAttempt: { parentId: "superseded-parent", instanceId: "superseded-child" },
    }),
  ).rejects.toThrow("source_parse_authority_superseded");
  expect(attempts).toBe(2);
  expect(batches).toHaveLength(1);
  expect(await retainedRows(db, snapshot.id, sealed.id)).toEqual(before);
  expect(observed.calls).toEqual([]);

  await archiveRecoveryFence(db).run();
  await expect(parseSnapshotBatch(measuredDb, observed.bucket, snapshot.id, version, intent)).rejects.toThrow(
    "catalogue_recovery_writer_fenced",
  );
  expect(attempts).toBe(3);
  expect(batches).toHaveLength(1);
  expect(await retainedRows(db, snapshot.id, sealed.id)).toEqual(before);
  expect(observed.calls).toEqual([]);
});

test("sealed archive discovery preserves evidence when one extra image request would exceed pilot capacity", async () => {
  const { db, run, request, snapshot } = await seedArchive(
    "archive-discovery-capacity-boundary",
    false,
    archiveBytes([reminder, control, reversible, art]),
  );
  const intent = { intent: "collection" as const, idempotencyKey: `${run.id}:${request.request_id}` };
  const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent);
  if ("kind" in sealed) throw new Error("Four-record archive should seal in one callback.");
  expect(sealed.observation_count).toBe(4);
  const before = await retainedRows(db, snapshot.id, sealed.id);
  const requests = (await queries.archiveReplayRequests(db).bind(run.id).all()).results;
  expect(requests).toHaveLength(5);
  const discoveries = [];
  for await (const page of discoveredSourceRecordRequests(db, sealed.id)) discoveries.push(...page);
  expect(new Set(discoveries.map(({ url }) => url)).size).toBe(6);
  const observed = observedBucket();
  expect(await parseCapturedRequest(db, observed.bucket, run, request, snapshot.id)).toEqual({
    kind: "done",
    failure_code: null,
    request_made: false,
  });
  const paused = await requiredEvidenceRun(db, run.id);
  expect(paused).toMatchObject({ state: "paused", failure_code: null });
  const pause = await currentPause(db, run.id);
  expect(pause).toMatchObject({
    reason: "source_request_capacity_exhausted",
    document: {
      capacity_generation: 1,
      request_capacity: 10,
      used_capacity: 5,
      overflow_request_count: 6,
      required_capacity: 11,
    },
  });
  expect((await queries.archiveReplayRequests(db).bind(run.id).all()).results).toEqual(requests);
  expect(await retainedRows(db, snapshot.id, sealed.id)).toEqual(before);
  expect(before.archiveCursor).toMatchObject({ state: "normalized", discovery_ordinal: 0 });
  expect(await queries.archiveReplayReservation(db).first("active_ingestion_run_id")).toBe(run.id);
  expect(observed.calls).toEqual([]);
  expect(await parseCapturedRequest(db, observed.bucket, paused, request, snapshot.id)).toEqual({
    kind: "done",
    failure_code: null,
    request_made: false,
  });
  expect(await currentPause(db, run.id)).toEqual(pause);
  expect((await queries.archiveReplayRequests(db).bind(run.id).all()).results).toEqual(requests);
  expect(await retainedRows(db, snapshot.id, sealed.id)).toEqual(before);
  expect(observed.calls).toEqual([]);
});
