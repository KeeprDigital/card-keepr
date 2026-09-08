import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
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
async function seed(id: string, duplicate = false, terminal = false) {
  const document = structuredClone(page);
  document.data = document.data.slice(0, 17);
  if (duplicate) document.data[16] = document.data[0]!;
  document.metadata.totalItems = 17;
  document.metadata.totalPages = 1;
  document.linkdata.last = document.linkdata.first;
  delete (document.linkdata as { next?: string }).next;
  const bytes = utf8(JSON.stringify(document));
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id,
    state: terminal ? "failed" : "collecting",
    idempotency_key: id,
    ...(terminal
      ? { failure_code: "fixture", started_at: "2026-08-01T00:00:00.000Z", terminal_at: "2026-08-01T00:00:00.000Z" }
      : {}),
  }).run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,'request',1,'GET',?,'{}','fixture','captured')`)
    .bind(id, url)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,'request',1,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z','success','{}')`)
    .bind(id, id)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,'request',?,'GET',?,'{}','fixture','[]','2026-09-08T00:00:00.000Z',200,'{}','application/json',?,?,?,'riftbound-en','riftbound','riftbound@1',?)`)
    .bind(id, id, id, url, await sha256(bytes), bytes.length, `source-snapshots/${id}`, adapterVersion)
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
