import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import { parseSnapshot } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import type { SourceRequestRole } from "../../../src/catalogue/source-evidence/source-evidence-model";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedRunFixtureStatement } from "./query-helpers/run-events";

installRuntimeSuite();

async function retainResponse(
  id: string,
  role: SourceRequestRole,
  mediaType: string,
  bytes: Uint8Array,
  requestIdOverride?: string,
) {
  const database = env.CATALOGUE_DB;
  const requestId = requestIdOverride ?? `one-piece-en:${role}:${id}`;
  const url =
    role === "image"
      ? "https://en.onepiece-cardgame.com/images/cardlist/card/ST01-001.png"
      : "https://en.onepiece-cardgame.com/cardlist/?series=569116";
  await seedRunFixtureStatement(database, { id, state: "collecting", idempotency_key: id }).run();
  await database
    .prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state,request_role)
    VALUES (?,?,1,'GET',?,'{}','fixture','captured',?)`)
    .bind(id, requestId, url, role)
    .run();
  await database
    .prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,?,1,'2026-09-09T00:00:00.000Z','2026-09-09T00:00:00.000Z','success','{}')`)
    .bind(id, id, requestId)
    .run();
  await database
    .prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,
     representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,
     content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,?,?,'GET',?,'{}','fixture','[]','2026-09-09T00:00:00.000Z',200,'{}',?,?,?,?,
      'one-piece-en','one-piece','one-piece@1','one-piece-en@6')`)
    .bind(id, id, requestId, id, url, mediaType, await sha256(bytes), bytes.length, `source-snapshots/${id}`)
    .run();
  await env.EVIDENCE_OBJECTS.put(`source-snapshots/${id}`, bytes);
}

function parse(id: string) {
  return parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, id, "one-piece-en@6", {
    intent: "collection",
    idempotencyKey: id,
  });
}

test("a document request rejects an image-labelled response while preserving its retained bytes", async () => {
  const id = "document-image-media-type";
  const bytes = utf8("unexpected non-HTML response body");
  await retainResponse(id, "surface", "image/png", bytes);
  await expect(parse(id)).rejects.toMatchObject({ code: "source_parse_failed" });
  expect(new Uint8Array(await (await env.EVIDENCE_OBJECTS.get(`source-snapshots/${id}`))!.arrayBuffer())).toEqual(
    bytes,
  );
});

test("a document role cannot become an image role through its request identifier", async () => {
  const id = "document-image-id";
  await retainResponse(id, "surface", "image/png", utf8("not card facts"), "one-piece-en:image:misleading-id");
  await expect(parse(id)).rejects.toMatchObject({ code: "source_parse_failed" });
});

test("a planned image retains its empty observation set and replay identity", async () => {
  const id = "planned-image";
  const bytes = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
    (character) => character.charCodeAt(0),
  );
  await retainResponse(id, "image", "image/png", bytes, "publisher-artwork-request");
  const first = await parse(id);
  expect(first.observation_count).toBe(0);
  expect(await parse(id)).toEqual(first);
});

test.each([
  ["text/html", "<html>not an image</html>"],
  ["image/png", ""],
])("a planned image rejects invalid retained response %s", async (mediaType, body) => {
  const id = `invalid-planned-image-${mediaType.replace("/", "-")}`;
  await retainResponse(id, "image", mediaType, utf8(body));
  await expect(parse(id)).rejects.toMatchObject({ code: "source_parse_failed" });
});
