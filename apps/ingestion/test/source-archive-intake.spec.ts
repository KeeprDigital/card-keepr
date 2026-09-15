import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import etched from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import { parseCapturedRequest } from "../../../src/catalogue/source-evidence";
import { catalogueStore, sha256 } from "../../../src/catalogue/shared";
import { decodeArchiveBatch } from "../../../src/catalogue/source-evidence/source-archive-decode";
import { sourceParseAuthorityGuard } from "../../../src/catalogue/source-evidence/source-parse-authority-repository";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import * as queries from "./query-helpers/source-archive";
import { installRuntimeSuite } from "./runtime-helpers";
import { raw, version, seedArchive } from "./source-archive-fixture";

installRuntimeSuite();

function failingArchiveRead(key: string, failure: TypeError, location: "get" | "body"): R2Bucket {
  return new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (requested: string) => {
          if (requested === key && location === "get") throw failure;
          const object = await target.get(requested);
          if (!object || requested !== key) return object;
          // Cancel the real returned stream before substituting the failed read;
          // the retained R2 object and its bytes remain unchanged.
          await object.body.cancel();
          const body = new ReadableStream<Uint8Array>({
            pull() {
              throw failure;
            },
          });
          return new Proxy(object, {
            get(value, field) {
              if (field === "body") return body;
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
  const receipt = await decodeArchiveBatch(db, env.EVIDENCE_OBJECTS, snapshot, pin, guard, 4);
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

test("archive normalization resumes an exact finish cursor and finalizes one bounded observation manifest", async () => {
  const { db, snapshot } = await seedArchive("archive-finish-replay");
  let injected = false;
  const failing = catalogueStore(
    new Proxy(env.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!injected && (await queries.archiveRecordCount(db).first("count")) === 9) {
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
  // Forest has two retained finishes: the acknowledged nonfoil observation
  // must survive a lost response before its foil observation is committed.
  expect(await queries.archiveParseCursor(db).bind(snapshot.id).first()).toEqual({
    next_record: 5,
    next_variant: 1,
    observation_count: 9,
  });
  const completed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent);
  if ("kind" in completed) throw new Error("Small archive should be complete after replay");
  expect(completed.observation_count).toBe(11);
  expect(completed.content_byte_length).toBeLessThan(32768);
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

test.each(["native", "coalesced"] as const)(
  "synthetic repeated archive bytes keep %s reads below their buffer bound",
  async (delivery) => {
    // Fourteen repetitions make the gzip just larger than 64 KiB. This tests the
    // read boundary only; repeated UUIDs are not a valid normalized source scope.
    const repeated = new Uint8Array(raw.byteLength * 14);
    for (let i = 0; i < 14; i++) repeated.set(raw, i * raw.byteLength);
    const { db, run, snapshot, pin } = await seedArchive("archive-native-read-bound", false, repeated);
    expect(snapshot.content_byte_length).toBeGreaterThan(65536);
    let maximumRead = 0,
      reads = 0;
    const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
      get(target, property) {
        if (property === "get")
          return async (...args: Parameters<R2Bucket["get"]>) => {
            const object = await target.get(...args);
            if (!object || !("body" in object)) return object;
            // Preserve the actual retained bytes while controlling their delivery
            // as one legal large byte-stream chunk at the storage-read boundary.
            const bytes = delivery === "coalesced" ? new Uint8Array(await object.arrayBuffer()) : null;
            const source =
              bytes === null
                ? object.body
                : new ReadableStream({
                    type: "bytes",
                    start(controller) {
                      controller.enqueue(bytes);
                      controller.close();
                    },
                  });
            return new Proxy(object, {
              get(value, field) {
                if (field === "body")
                  return new Proxy(source, {
                    get(stream, member) {
                      if (member === "getReader")
                        return (options?: ReadableStreamGetReaderOptions) => {
                          const reader = options === undefined ? stream.getReader() : stream.getReader(options);
                          return new Proxy(reader, {
                            get(native, method) {
                              if (method === "read")
                                return async (...inputs: unknown[]) => {
                                  const next = (await Reflect.apply(
                                    native.read,
                                    native,
                                    inputs,
                                  )) as ReadableStreamReadResult<Uint8Array>;
                                  if (!next.done) {
                                    reads++;
                                    maximumRead = Math.max(maximumRead, next.value.byteLength);
                                  }
                                  return next;
                                };
                              const result = Reflect.get(native, method, native);
                              return typeof result === "function" ? result.bind(native) : result;
                            },
                          });
                        };
                      const result = Reflect.get(stream, member, stream);
                      return typeof result === "function" ? result.bind(stream) : result;
                    },
                  });
                const result = Reflect.get(value, field, value);
                return typeof result === "function" ? result.bind(value) : result;
              },
            });
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(
      await decodeArchiveBatch(db, bucket, snapshot, pin, () =>
        sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
      ),
    ).toMatchObject({ state: "decoded", next_record: 98, decoded_digest: await sha256(repeated) });
    expect(maximumRead).toBeLessThanOrEqual(65536);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(await queries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
  },
);
