import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import etched from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import { parseCapturedRequest } from "../../../src/catalogue/source-evidence";
import { catalogueStore, gunzipChunkBytes, gunzipRangeBytes, sha256 } from "../../../src/catalogue/shared";
import {
  archiveDecodeStepBudget,
  decodeArchiveBatch,
} from "../../../src/catalogue/source-evidence/source-archive-decode";
import { sourceParseAuthorityGuard } from "../../../src/catalogue/source-evidence/source-parse-authority-repository";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import * as queries from "./query-helpers/source-archive";
import { installRuntimeSuite } from "./runtime-helpers";
import { distinctArchiveRecords, raw, version, seedArchive } from "./source-archive-fixture";

installRuntimeSuite();

function failingArchiveRead(key: string, failure: TypeError, location: "get" | "body"): R2Bucket {
  return new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const [requested] = args;
          if (requested === key && location === "get") throw failure;
          const object = await target.get(...args);
          if (!object || requested !== key || !("body" in object)) return object;
          // Cancel the real returned stream before substituting the failed read;
          // the retained R2 object and its bytes remain unchanged.
          await object.body.cancel();
          return new Proxy(object, {
            get(value, field) {
              if (field === "body" || field === "arrayBuffer" || field === "bytes")
                return field === "body"
                  ? new ReadableStream<Uint8Array>({
                      pull() {
                        throw failure;
                      },
                    })
                  : async () => {
                      throw failure;
                    };
              const result = Reflect.get(value, field, value);
              return typeof result === "function" ? result.bind(value) : result;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test.each(["get", "body"] as const)(
  "an upstream R2 %s TypeError preserves the captured request and exact parse intent",
  async (location) => {
    const { db, run, request, snapshot } = await seedArchive(
      `archive-upstream-${location}`,
      false,
      new TextEncoder().encode(etched),
    );
    const failure = new TypeError(`archive R2 ${location} unavailable`);
    await expect(
      parseCapturedRequest(
        db,
        failingArchiveRead(snapshot.content_object_key, failure, location),
        run,
        request,
        snapshot.id,
      ),
    ).rejects.toBe(failure);
    const key = `${run.id}:${request.request_id}`;
    const before = await queries
      .archiveRequestParseState(db)
      .bind(run.id, request.request_id, "collection", key)
      .first();
    expect(before).toMatchObject({ state: "captured", failure_code: null });
    expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
    expect(await parseCapturedRequest(db, env.EVIDENCE_OBJECTS, run, request, snapshot.id)).toEqual({
      kind: "done",
      failure_code: null,
      request_made: false,
    });
    expect(
      await queries.archiveRequestParseState(db).bind(run.id, request.request_id, "collection", key).first(),
    ).toEqual({ ...before, state: "observed", parse_state: "finalized" });
    const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, {
      intent: "collection",
      idempotencyKey: key,
    });
    expect(sealed).toMatchObject({ id: before!.observation_set_id, observation_count: 1 });
    expect(
      await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, {
        intent: "collection",
        idempotencyKey: key,
      }),
    ).toEqual(sealed);
    expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(1);
  },
);

test("derived archive blocks replay a committed prefix without sealing partial evidence", async () => {
  const { db, run, snapshot, pin } = await seedArchive("archive-prefix-replay");
  let injected = false;
  const failing = catalogueStore(
    new Proxy(env.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            const progress = await queries.archiveDecodeReceipt(db).bind(snapshot.id).first<{ next_block: number }>();
            if (!injected && progress?.next_block === 1) {
              injected = true;
              throw new Error("lost archive checkpoint response");
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const guard = () => sourceParseAuthorityGuard(db, run.id, { intent: "collection" });
  // A smaller supported block layout crosses the storage boundary with seven
  // real records; the production adapter keeps its 1024-record block ceiling.
  await expect(decodeArchiveBatch(failing, env.EVIDENCE_OBJECTS, snapshot, pin, guard, 4)).rejects.toThrow(
    "lost archive checkpoint response",
  );
  expect(injected).toBe(true);
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
  const before = await queries.archiveBlockReceipts(db).bind(snapshot.id).all();
  const beforeCursor = await queries.archiveDecodeReceipt(db).bind(snapshot.id).first();
  expect(before.results).toHaveLength(1);
  const upstream = new TypeError("retained archive read unavailable during prefix replay");
  await expect(
    decodeArchiveBatch(db, failingArchiveRead(snapshot.content_object_key, upstream, "body"), snapshot, pin, guard, 4),
  ).rejects.toBe(upstream);
  expect((await queries.archiveBlockReceipts(db).bind(snapshot.id).all()).results).toEqual(before.results);
  expect(await queries.archiveDecodeReceipt(db).bind(snapshot.id).first()).toEqual(beforeCursor);
  // Re-deriving the committed prefix spends the same per-call block budget as
  // retaining it, so the replay reaches EOF over more than one bounded call.
  let receipt = await decodeArchiveBatch(db, env.EVIDENCE_OBJECTS, snapshot, pin, guard, 4);
  expect(receipt.state).toBe("decoding");
  receipt = await decodeArchiveBatch(db, env.EVIDENCE_OBJECTS, snapshot, pin, guard, 4);
  expect(receipt).toMatchObject({
    state: "decoded",
    next_block: 2,
    next_record: 7,
    decoded_bytes: raw.byteLength,
    decoded_digest: await sha256(raw),
  });
  const after = await queries.archiveBlockReceipts(db).bind(snapshot.id).all();
  expect(after.results[0]).toEqual(before.results[0]);
  expect(after.results).toHaveLength(2);
  expect(await queries.archiveRequestCount(db).bind(run.id).first("count")).toBe(5);
  const stale = () =>
    sourceParseAuthorityGuard(db, run.id, {
      intent: "collection",
      workflowAttempt: { parentId: "superseded-parent", instanceId: "superseded-child" },
    });
  await expect(decodeArchiveBatch(db, env.EVIDENCE_OBJECTS, snapshot, pin, stale, 4)).rejects.toThrow(
    "source_parse_authority_superseded",
  );
  expect((await queries.archiveBlockReceipts(db).bind(snapshot.id).all()).results).toEqual(after.results);
});

/**
 * The live #327 failure: an archive whose compressed form spans several
 * `gunzipRangeBytes` ranges stalls the decoder at a range boundary, so the
 * Workflow step burns its whole CPU allowance without decoding a byte,
 * committing a block or reading another range. Every earlier archive fixture
 * repeats a few records and compresses inside one range, which is why a step
 * count alone never caught it. This holds each call to a decode budget and to
 * the reads that budget allows.
 */
test("an archive spanning many compressed ranges decodes within its per-call budget", async () => {
  const input = distinctArchiveRecords(3000, 4600);
  const { db, run, snapshot, pin } = await seedArchive("archive-range-spanning", false, input);
  expect(snapshot.content_byte_length).toBeGreaterThan(4 * gunzipRangeBytes);
  // A call inflates its blocks, the open record it must finish, and at most
  // one decoded chunk beyond them; it reads only the ranges those bytes need.
  const decodeBound =
    archiveDecodeStepBudget.blocks * archiveDecodeStepBudget.blockBytes + pin.limits.recordBytes + gunzipChunkBytes;
  const readBound = Math.ceil(decodeBound / gunzipRangeBytes) + 1;
  let ranges = 0;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          if (args[0] === snapshot.content_object_key) ranges++;
          return target.get(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const guard = () => sourceParseAuthorityGuard(db, run.id, { intent: "collection" });
  let calls = 0;
  let decoded = 0;
  let receipt;
  do {
    const before = { blocks: receipt?.next_block ?? 0, decoded, ranges };
    receipt = await decodeArchiveBatch(db, bucket, snapshot, pin, guard);
    calls++;
    // Each call advances the cursor and stays inside the declared budget:
    // a stalled call decodes nothing and reads nothing however long it runs.
    expect(receipt.decoded_bytes - before.decoded, `call ${calls} decoded`).toBeGreaterThan(0);
    expect(receipt.decoded_bytes - before.decoded, `call ${calls} decoded`).toBeLessThanOrEqual(decodeBound);
    expect(ranges - before.ranges, `call ${calls} ranges`).toBeLessThanOrEqual(readBound);
    expect(receipt.next_block - before.blocks, `call ${calls} blocks`).toBeLessThanOrEqual(
      archiveDecodeStepBudget.blocks + 1,
    );
    decoded = receipt.decoded_bytes;
  } while (receipt.state !== "decoded" && calls <= 64);
  expect(receipt).toMatchObject({
    state: "decoded",
    next_record: 3000,
    decoded_bytes: input.byteLength,
    decoded_digest: await sha256(input),
  });
  // Many calls, each bounded, over an archive no single call could hold.
  expect(calls).toBeGreaterThanOrEqual(Math.ceil(receipt.next_block / archiveDecodeStepBudget.blocks));
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
});

test("a lost normalization response replays from its committed cursors without duplicate records", async () => {
  const { db, snapshot } = await seedArchive("archive-finish-replay");
  let injected = false;
  const failing = catalogueStore(
    new Proxy(env.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!injected && ((await queries.archiveRecordCount(db).first<number>("count")) ?? 0) > 0) {
              injected = true;
              throw new Error("lost normalized record response");
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  const intent = { intent: "collection" as const, idempotencyKey: "archive-finish-replay" };
  await expect(parseSnapshotBatch(failing, env.EVIDENCE_OBJECTS, snapshot.id, version, intent)).rejects.toThrow(
    "lost normalized record response",
  );
  expect(injected).toBe(true);
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
  // One atomic transaction admitted every record with both cursors; forest's
  // two finishes were committed together with its receipt.
  const committed = await queries.archiveParseCursor(db).bind(snapshot.id).first();
  expect(committed).toEqual({ next_record: 7, next_variant: 0, observation_count: 11 });
  expect(await queries.archiveRecordCount(db).first("count")).toBe(11);
  const completed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent);
  if ("kind" in completed) throw new Error("Small archive should be complete after replay");
  expect(completed.observation_count).toBe(11);
  expect(completed.content_byte_length).toBeLessThan(32768);
  expect(await queries.archiveRecordCount(db).first("count")).toBe(11);
  expect(await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent)).toEqual(completed);
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(1);
  const requests = [];
  for await (const page of discoveredSourceRecordRequests(db, completed.id)) requests.push(...page);
  expect(new Set(requests.map(({ url }) => url)).size).toBe(9);
});

test("a corrupt gzip trailer never seals an archive or exposes observations", async () => {
  const { db, snapshot } = await seedArchive("archive-corrupt-trailer", true);
  await expect(
    parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, {
      intent: "collection",
      idempotencyKey: "archive-corrupt-trailer",
    }),
  ).rejects.toMatchObject({ code: "source_parse_failed" });
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
  expect(await queries.archiveDecodeReceipt(db).bind(snapshot.id).first("state")).toBe("decoding");
});

test("retained archive decoding reads bounded ranges from its cursor and never re-reads the prefix", async () => {
  // Fourteen repetitions exceed one 64 KiB decoded chunk. This tests the read
  // boundary only; repeated UUIDs are not a valid normalized source scope.
  const repeated = new Uint8Array(raw.byteLength * 14);
  for (let i = 0; i < 14; i++) repeated.set(raw, i * raw.byteLength);
  const { db, run, snapshot, pin } = await seedArchive("archive-native-read-bound", false, repeated);
  const reads: { offset: number; length: number }[] = [];
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const [key, options] = args;
          if (key === snapshot.content_object_key) {
            const range = options?.range as { offset: number; length: number } | undefined;
            if (!range) throw new Error("The retained archive must be read by bounded range.");
            reads.push(range);
          }
          return target.get(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const guard = () => sourceParseAuthorityGuard(db, run.id, { intent: "collection" });
  // Four-record blocks make this archive take several bounded calls.
  let calls = 0,
    receipt;
  do {
    receipt = await decodeArchiveBatch(db, bucket, snapshot, pin, guard, 4);
    calls++;
    expect(receipt.next_block).toBeLessThanOrEqual(calls * archiveDecodeStepBudget.blocks + 1);
  } while (receipt.state !== "decoded");
  expect(calls).toBeGreaterThan(2);
  expect(receipt).toMatchObject({ state: "decoded", next_record: 98, decoded_digest: await sha256(repeated) });
  expect(reads.every(({ length }) => length <= gunzipRangeBytes)).toBe(true);
  // Each call resumes at its persisted compressed cursor: reads only move
  // forward, so no call re-inflates the retained prefix.
  expect(reads.map(({ offset }) => offset)).toEqual(reads.map(({ offset }) => offset).sort((a, b) => a - b));
  expect(reads.at(-1)!.offset).toBeGreaterThan(0);
  expect(reads.at(-1)!.offset + reads.at(-1)!.length).toBe(snapshot.content_byte_length);
  expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
});
