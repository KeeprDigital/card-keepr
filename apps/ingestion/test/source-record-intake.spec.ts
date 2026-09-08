import { ReconciliationDocumentStorageError } from "../../../src/catalogue/reconciliation/reconciliation-document";
import { riftboundSourceAdapterRegistration as adapter } from "../../../src/catalogue/adapters/riftbound-source-adapter";
import {
  sourceRecordPage,
  type SourceRecordRow,
} from "../../../src/catalogue/source-evidence/source-record-repository";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import page from "../../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import { parseSnapshot } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedRunFixtureStatement } from "./query-helpers/run-events";

installRuntimeSuite();
const url =
  "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200";
const adapterVersion = "riftbound-en@1";
async function seed(
  id: string,
  duplicate = false,
  terminal = false,
  pagination?: { index: number; pages: number; runId?: string },
) {
  const document = structuredClone(page);
  document.data = document.data.slice(0, 17);
  if (duplicate) document.data[16] = document.data[0]!;
  document.metadata.totalItems = 17;
  document.metadata.totalPages = 1;
  document.linkdata.last = document.linkdata.first;
  delete (document.linkdata as { next?: string }).next;
  const requestUrl = new URL(url);
  if (pagination) {
    requestUrl.searchParams.set("from", String(pagination.index * 200));
    const pageUrl = (index: number) => {
      const next = new URL(url);
      next.searchParams.set("from", String(index * 200));
      return next.href;
    };
    document.metadata.from = pagination.index * 200;
    document.metadata.totalItems = pagination.pages * 200;
    document.metadata.totalPages = pagination.pages;
    document.linkdata.self = pageUrl(pagination.index);
    document.linkdata.first = pageUrl(0);
    document.linkdata.last = pageUrl(pagination.pages - 1);
    if (pagination.index + 1 < pagination.pages) document.linkdata.next = pageUrl(pagination.index + 1);
  }
  const bytes = utf8(JSON.stringify(document));
  const runId = pagination?.runId ?? id;
  if (!pagination?.runId || pagination.index === 0)
    await seedRunFixtureStatement(env.CATALOGUE_DB, {
      id: runId,
      state: terminal ? "failed" : "collecting",
      idempotency_key: id,
      ...(terminal
        ? { failure_code: "fixture", started_at: "2026-08-01T00:00:00.000Z", terminal_at: "2026-08-01T00:00:00.000Z" }
        : {}),
    }).run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,?,?,'GET',?,'{}','fixture','captured')`)
    .bind(runId, id, (pagination?.index ?? 0) + 1, requestUrl.href)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,?,1,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z','success','{}')`)
    .bind(id, runId, id)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,?,?,'GET',?,'{}','fixture','[]','2026-09-08T00:00:00.000Z',200,'{}','application/json',?,?,?,'riftbound-en','riftbound','riftbound@1',?)`)
    .bind(
      id,
      runId,
      id,
      id,
      requestUrl.href,
      await sha256(bytes),
      bytes.length,
      `source-snapshots/${id}`,
      adapterVersion,
    )
    .run();
  await env.EVIDENCE_OBJECTS.put(`source-snapshots/${id}`, bytes);
}
const intent = { intent: "collection" as const, idempotencyKey: "bounded-page" };

test("Riot record batches recover a committed write with a lost response and finalize one small manifest", async () => {
  const id = "bounded-record-replay";
  await seed(id);
  let injected = false;
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          const progress = await target
            .prepare("SELECT next_ordinal FROM source_record_progress")
            .first<{ next_ordinal: number }>();
          if (!injected && progress?.next_ordinal === 8) {
            injected = true;
            throw new Error("lost record batch response");
          }
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
  ).rejects.toThrow("lost record batch response");
  expect(injected).toBe(true);
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(0);
  const first = await parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, id, adapterVersion, intent);
  expect(await parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, id, adapterVersion, intent)).toEqual(
    first,
  );
  expect(first.observation_count).toBe(17);
  expect(first.content_byte_length).toBeLessThan(2048);
  const manifest = await (await env.EVIDENCE_OBJECTS.get(first.content_object_key))!.json<Record<string, unknown>>();
  expect(manifest.observations).toBeUndefined();
  expect(manifest.record_storage).toMatchObject({ count: 17 });
  const requests = [];
  for await (const batch of discoveredSourceRecordRequests(catalogueStore(database), first.id)) {
    expect(batch.length).toBeLessThanOrEqual(8);
    requests.push(...batch);
  }
  expect(requests).toHaveLength(17);
  expect(
    requests.every((request) => request.role === "image" && new URL(request.url).hostname === "cmsassets.rgpub.io"),
  ).toBe(true);
  expect(await readSourceObservation(catalogueStore(database), "no-staged-copy", first.id, 0)).toMatchObject({
    ordinal: 1,
    value: { card: { game: "riftbound" } },
  });
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_record_pages").first("n")).toBe(17);
});

test("duplicate publisher IDs after a persisted prefix never finalize an authoritative set", async () => {
  const id = "bounded-record-duplicate";
  await seed(id, true);
  await expect(
    parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
  ).rejects.toMatchObject({ code: "source_parse_failed" });
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(0);
  const progress = await env.CATALOGUE_DB.prepare("SELECT next_ordinal,sealed FROM source_record_progress").first();
  expect(progress).toEqual({ next_ordinal: 16, sealed: 0 });
});

test("evidence cleanup drains record payloads in bounded units and retains sealed audit receipts", async () => {
  const id = "bounded-record-cleanup";
  await seed(id, false, true);
  const db = catalogueStore(env.CATALOGUE_DB);
  const set = await parseSnapshot(db, env.EVIDENCE_OBJECTS, id, adapterVersion, intent);
  const cleanup = await beginEvidenceCleanup(db, id, id, 30, "2026-09-08T00:00:00.000Z");
  let result = cleanup;
  for (let i = 0; i < 10 && result.state !== "completed"; i++)
    result = await advanceEvidenceCleanup(db, env.EVIDENCE_OBJECTS, cleanup.id, "2026-09-08T00:00:00.000Z");
  expect(result.state).toBe("completed");
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_record_pages").first("n")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare("SELECT next_ordinal,sealed FROM source_record_progress").first()).toEqual({
    next_ordinal: 17,
    sealed: 1,
  });
  await expect(readSourceObservation(db, "cleanup", set.id, 0)).rejects.toThrow("not sealed");
  expect(await env.EVIDENCE_OBJECTS.head(set.content_object_key)).toBeNull();
});

test("same-size raw byte corruption cannot finalize a set", async () => {
  const id = "bounded-record-corruption";
  await seed(id);
  const key = `source-snapshots/${id}`;
  const raw = await (await env.EVIDENCE_OBJECTS.get(key))!.text();
  await env.EVIDENCE_OBJECTS.put(key, raw.replace("Alluring", "AlLuring"));
  await expect(
    parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
  ).rejects.toThrow("digest verification");
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(0);
});

test.each([1, 4])(
  "%i pages keep one active writer, at most nine emitted records ahead and bounded reads",
  async (pages) => {
    let emitted = 0,
      committed = 0,
      maximumAhead = 0,
      activeWrites = 0,
      maximumActiveWrites = 0,
      maximumStatements = 0;
    const extract = adapter.recordExtraction.extract;
    const spy = vi.spyOn(adapter.recordExtraction, "extract").mockImplementation(async (...args) => {
      const extracted = await extract(...args);
      return {
        ...extracted,
        records: (async function* () {
          for await (const record of extracted.records) {
            emitted++;
            maximumAhead = Math.max(maximumAhead, emitted - committed);
            yield record;
          }
        })(),
      };
    });
    const database = new Proxy(env.CATALOGUE_DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            maximumStatements = Math.max(maximumStatements, statements.length);
            maximumActiveWrites = Math.max(maximumActiveWrites, ++activeWrites);
            // A delayed sink must stop the extractor rather than queue another batch.
            await new Promise((resolve) => setTimeout(resolve, 1));
            const result = await target.batch(statements);
            committed = Number(
              await target
                .prepare("SELECT COALESCE(SUM(next_ordinal),0) FROM source_record_progress")
                .first("COALESCE(SUM(next_ordinal),0)"),
            );
            activeWrites--;
            return result;
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
      get(target, key) {
        if (key === "get")
          return async (...args: Parameters<R2Bucket["get"]>) => {
            const object = await target.get(...args);
            if (!object) return object;
            return new Proxy(object, {
              get(body, method) {
                if (["arrayBuffer", "text", "json"].includes(String(method)))
                  return () => {
                    throw new Error("Whole raw body materialized");
                  };
                const value = Reflect.get(body, method, body);
                return typeof value === "function" ? value.bind(body) : value;
              },
            });
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      for (let index = 0; index < pages; index++) {
        const id = `bounded-pages-${pages}-${index}`;
        await seed(id, false, false, { index, pages, runId: `bounded-pages-${pages}` });
        const set = await parseSnapshot(catalogueStore(database), bucket, id, adapterVersion, intent);
        for (let after = -1; ; ) {
          const records = (await sourceRecordPage(catalogueStore(database), set.id, after).all<SourceRecordRow>())
            .results;
          if (!records.length) break;
          expect(records.length).toBeLessThanOrEqual(8);
          expect(records.reduce((bytes, record) => bytes + utf8(record.content).byteLength, 0)).toBeLessThanOrEqual(
            512000,
          );
          after = records.at(-1)!.ordinal;
        }
      }
      expect(emitted).toBe(pages * 17);
      expect(committed).toBe(emitted);
      expect(maximumAhead).toBe(9);
      expect(maximumActiveWrites).toBe(1);
      expect(maximumStatements).toBe(9);
    } finally {
      spy.mockRestore();
    }
  },
);

test("a later self-consistent page cannot shorten the initial pagination declaration", async () => {
  const runId = "bounded-pagination-drift",
    db = catalogueStore(env.CATALOGUE_DB);
  await seed(`${runId}-0`, false, false, { index: 0, pages: 4, runId });
  await parseSnapshot(db, env.EVIDENCE_OBJECTS, `${runId}-0`, adapterVersion, intent);
  await seed(`${runId}-1`, false, false, { index: 1, pages: 2, runId });
  await expect(parseSnapshot(db, env.EVIDENCE_OBJECTS, `${runId}-1`, adapterVersion, intent)).rejects.toMatchObject({
    code: "source_parse_failed",
    message: "Riftbound pagination identity changed within the collection.",
  });
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(1);
});

test("temporary progress-query failure remains a storage retry and resumes intact records", async () => {
  const id = "bounded-record-read-retry";
  await seed(id);
  const set = await parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, id, adapterVersion, intent);
  let fail = true;
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM source_record_progress")) return statement;
          return new Proxy(statement, {
            get(prepared, method) {
              if (method === "bind")
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  return new Proxy(bound, {
                    get(result, operation) {
                      if (operation === "first")
                        return async () => {
                          if (fail) {
                            fail = false;
                            throw new Error("temporary D1 outage");
                          }
                          return result.first();
                        };
                      const value = Reflect.get(result, operation, result);
                      return typeof value === "function" ? value.bind(result) : value;
                    },
                  });
                };
              const value = Reflect.get(prepared, method, prepared);
              return typeof value === "function" ? value.bind(prepared) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = catalogueStore(database);
  await expect(readSourceObservation(db, "retry", set.id, 0)).rejects.toBeInstanceOf(
    ReconciliationDocumentStorageError,
  );
  await expect(readSourceObservation(db, "retry", set.id, 0)).resolves.toMatchObject({ ordinal: 1 });
});

test("concurrent retries converge on exact record receipts and one sealed set", async () => {
  const id = "bounded-record-concurrent";
  await seed(id);
  let release = () => {},
    arrivals = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length === 9 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const db = catalogueStore(database);
  const results = await Promise.all([
    parseSnapshot(db, env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
    parseSnapshot(db, env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
  ]);
  expect(arrivals).toBe(2);
  expect(results[0]).toEqual(results[1]);
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_record_pages").first("n")).toBe(17);
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(1);
});

test("cleanup between a partial commit and its receipt fences the remaining writer", async () => {
  const id = "bounded-record-cleanup-race";
  await seed(id, false, true);
  let raced = false;
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          if (!raced && statements.length === 9) {
            raced = true;
            const db = catalogueStore(env.CATALOGUE_DB);
            let cleanup = await beginEvidenceCleanup(db, id, id, 30, "2026-09-08T00:00:00.000Z");
            for (let i = 0; i < 10 && cleanup.state !== "completed"; i++)
              cleanup = await advanceEvidenceCleanup(db, env.EVIDENCE_OBJECTS, cleanup.id, "2026-09-08T00:00:00.000Z");
            expect(cleanup.state).toBe("completed");
          }
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, id, adapterVersion, intent),
  ).rejects.toThrow("Immutable source record replay changed");
  expect(raced).toBe(true);
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_record_pages").first("n")).toBe(0);
  expect(await env.CATALOGUE_DB.prepare("SELECT COUNT(*) AS n FROM source_observation_sets").first("n")).toBe(0);
  await expect(env.CATALOGUE_DB.prepare("UPDATE source_record_progress SET next_ordinal=9").run()).rejects.toThrow(
    "evidence_cleanup_reference_fenced",
  );
});
