import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import metadataRaw from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/bulk-metadata.json?raw";
import delverRaw from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/delver.json?raw";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import {
  type EvidenceRequestRow,
  runRequestCapacityPolicy,
} from "../../../src/catalogue/source-evidence/source-evidence-repository";
import { archiveParseProgress } from "../../../src/catalogue/source-evidence/source-archive-repository";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import * as archiveQueries from "./query-helpers/source-archive";
import { archiveReplayRequests } from "./query-helpers/source-archive-replay";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

const metadataUrl = "https://api.scryfall.com/bulk-data";
const archiveUrl = "https://data.scryfall.io/default-cards/default-cards-20260914090527.jsonl.gz";
const version = "scryfall-magic-en@1";

async function startGraph(key: string, sizeOffset = 0, subset?: string) {
  const db = catalogueStore(env.CATALOGUE_DB);
  const compressed = new Uint8Array(
    await new Response(new Blob([utf8(delverRaw)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
  // Retain the source's metadata shape and timestamp, replacing only the size
  // for this explicitly small offline archive of one unmodified source record.
  const metadata = JSON.parse(metadataRaw);
  metadata.data.find((entry: { type: string }) => entry.type === "default_cards").compressed_size =
    compressed.length + sizeOffset;
  const body = JSON.stringify(metadata);
  const fetched: { url: string; headers: Record<string, string> }[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      fetched.push({ url: request.url, headers: Object.fromEntries(request.headers) });
      if (request.url === metadataUrl)
        return new Response(body, {
          headers: { "content-type": "application/json", "content-length": String(utf8(body).length) },
        });
      if (request.url === archiveUrl)
        return new Response(compressed, {
          headers: { "content-type": "application/gzip", "content-length": String(compressed.length) },
        });
      throw new Error(`Unexpected offline fixture request: ${request.url}`);
    },
  } as unknown as Fetcher;
  const input = {
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: version,
    idempotency_key: key,
    ...(subset === undefined ? {} : { subset }),
    requests: [
      {
        id: "scryfall-magic-en:bulk-data",
        url: metadataUrl,
        headers: { accept: "application/json", "user-agent": "Card-Keepr test" },
      },
    ],
  };
  const started = await startEvidenceRun(db, { ...input, acquisition_budget: fixtureAcquisitionBudget }),
    run = await requiredEvidenceRun(db, String(started.id));
  async function collect(request: EvidenceRequestRow) {
    return collectSourceRequestBatch({
      database: db,
      evidenceObjects: env.EVIDENCE_OBJECTS,
      officialSourceTransport: transport,
      runId: run.id,
      hostname: new URL(request.url).hostname,
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
      requests: [request],
    });
  }
  return { db, run, input, compressed, fetched, collect };
}

test("the complete Scryfall graph retains one metadata root, its pinned archive and current normal images", async () => {
  const { db, run, input, compressed, fetched, collect } = await startGraph("scryfall-complete-small-graph");
  expect(await runRequestCapacityPolicy(db, run.id, version)).toEqual({
    request_capacity: 108691,
    capacity_generation: 1,
  });
  const [root] = await pendingEvidenceRequests(db, run.id);
  expect(root).toMatchObject({ request_id: "scryfall-magic-en:bulk-data", request_role: "surface", url: metadataUrl });
  await collect(root!);
  const [archive] = await pendingEvidenceRequests(db, run.id);
  expect(archive).toMatchObject({
    request_role: "listing",
    url: archiveUrl,
    discovered_from_request_id: root!.request_id,
  });
  expect(archive!.request_id).toMatch(
    new RegExp(`^scryfall-magic-en:listing:bulk-20260914090527-${compressed.length}:[a-f0-9]{64}$`, "u"),
  );
  for (let callback = 0; callback < 6; callback++) {
    const retained = (await pendingEvidenceRequests(db, run.id)).find(
      ({ request_id }) => request_id === archive!.request_id,
    );
    if (!retained) break;
    await collect(retained);
  }
  const images = await pendingEvidenceRequests(db, run.id);
  expect(
    images.map(({ request_role, url, discovered_from_request_id }) => ({
      request_role,
      url,
      discovered_from_request_id,
    })),
  ).toEqual([
    {
      request_role: "image",
      url: "https://cards.scryfall.io/normal/front/6/9/6904ea20-e504-47da-95a0-08739fdde260.jpg?1783908173",
      discovered_from_request_id: archive!.request_id,
    },
    {
      request_role: "image",
      url: "https://cards.scryfall.io/normal/back/6/9/6904ea20-e504-47da-95a0-08739fdde260.jpg?1783908173",
      discovered_from_request_id: archive!.request_id,
    },
  ]);
  for (const request of images)
    expect(JSON.parse(request.request_headers_json)).toEqual({
      accept: "image/jpeg",
      "user-agent": "Card-Keepr/0.1 (+https://github.com/KeeprDigital/card-keepr)",
    });
  expect(fetched.map(({ url }) => url)).toEqual([metadataUrl, archiveUrl]);
  expect(fetched[1]!.headers).toMatchObject({
    "accept-encoding": "identity",
    accept: "application/gzip, application/octet-stream;q=0.9",
  });
  const requests = (await archiveReplayRequests(db).bind(run.id).all<EvidenceRequestRow>()).results;
  expect(requests).toHaveLength(4);
  const captured = requests.find(({ request_id }) => request_id === archive!.request_id)!;
  expect(captured.state).toBe("observed");
  const snapshot = await archiveQueries
    .archiveFixtureSnapshot(db)
    .bind(captured.source_snapshot_id)
    .first<{ content_digest: string; content_object_key: string }>();
  expect(snapshot!.content_digest).toBe(await sha256(compressed));
  expect(await (await env.EVIDENCE_OBJECTS.get(snapshot!.content_object_key))!.arrayBuffer()).toEqual(
    compressed.buffer,
  );
  const intent = { intent: "collection" as const, idempotencyKey: `${run.id}:${captured.request_id}` };
  const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, captured.source_snapshot_id!, version, intent);
  if ("kind" in sealed) throw new Error("One-record archive did not seal within six callbacks.");
  expect(sealed.observation_count).toBe(2);
  const progress = await archiveParseProgress(db, sealed.id).first();
  expect(progress).toMatchObject({ state: "complete", next_record: 1, discovery_ordinal: 2 });
  expect(await startEvidenceRun(db, { ...input, acquisition_budget: fixtureAcquisitionBudget })).toMatchObject({
    id: run.id,
  });
  await collect(root!);
  await collect(captured);
  expect((await requiredEvidenceRun(db, run.id)).request_plan_json).toBe(run.request_plan_json);
  expect((await archiveReplayRequests(db).bind(run.id).all()).results).toEqual(requests);
  expect(await archiveParseProgress(db, sealed.id).first()).toEqual(progress);
  expect(fetched).toHaveLength(2);
});

test("tranche 0 retains the complete pinned inventory and its image claims while acquiring no image", async () => {
  const { db, run, fetched, collect } = await startGraph("scryfall-facts-only-small-graph", 0, "facts-only");
  expect(JSON.parse(run.request_plan_json)).toMatchObject({ coverage: { subset: "facts-only" } });
  const [root] = await pendingEvidenceRequests(db, run.id);
  await collect(root!);
  const [archive] = await pendingEvidenceRequests(db, run.id);
  expect(archive).toMatchObject({ request_role: "listing", url: archiveUrl });
  for (let callback = 0; callback < 6; callback++) {
    const retained = (await pendingEvidenceRequests(db, run.id)).find(
      ({ request_id }) => request_id === archive!.request_id,
    );
    if (!retained) break;
    await collect(retained);
  }
  expect(await pendingEvidenceRequests(db, run.id)).toEqual([]);
  const requests = (await archiveReplayRequests(db).bind(run.id).all<EvidenceRequestRow>()).results;
  expect(requests.map(({ request_role, state }) => ({ request_role, state }))).toEqual([
    { request_role: "surface", state: "observed" },
    { request_role: "listing", state: "observed" },
  ]);
  const captured = requests[1]!;
  const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, captured.source_snapshot_id!, version, {
    intent: "collection",
    idempotencyKey: `${run.id}:${captured.request_id}`,
  });
  if ("kind" in sealed) throw new Error("One-record archive did not seal within six callbacks.");
  // The sealed interpretation keeps both image claims for a later budgeted tranche.
  expect(sealed.observation_count).toBe(2);
  const claims = [];
  for await (const page of discoveredSourceRecordRequests(db, sealed.id)) claims.push(...page);
  expect(claims.map(({ role, url }) => ({ role, url }))).toEqual([
    {
      role: "image",
      url: "https://cards.scryfall.io/normal/front/6/9/6904ea20-e504-47da-95a0-08739fdde260.jpg?1783908173",
    },
    {
      role: "image",
      url: "https://cards.scryfall.io/normal/back/6/9/6904ea20-e504-47da-95a0-08739fdde260.jpg?1783908173",
    },
  ]);
  expect(await archiveParseProgress(db, sealed.id).first()).toMatchObject({ state: "complete", discovery_ordinal: 2 });
  expect(fetched.map(({ url }) => url)).toEqual([metadataUrl, archiveUrl]);
});

test("an archive whose retained length disagrees with metadata never decodes or discovers images", async () => {
  const { db, run, compressed, fetched, collect } = await startGraph("scryfall-archive-pin-mismatch", 1);
  const [root] = await pendingEvidenceRequests(db, run.id);
  await collect(root!);
  const [archive] = await pendingEvidenceRequests(db, run.id);
  await collect(archive!);
  const requests = (await archiveReplayRequests(db).bind(run.id).all<EvidenceRequestRow>()).results;
  expect(requests).toHaveLength(2);
  const retained = requests[1]!;
  expect(retained).toMatchObject({ state: "failed", failure_code: "source_parse_failed" });
  expect(await archiveQueries.archiveDecodeReceipt(db).bind(retained.source_snapshot_id).first()).toBeNull();
  expect(await archiveQueries.archiveObservationCount(db).bind(retained.source_snapshot_id).first("count")).toBe(0);
  const snapshot = await archiveQueries
    .archiveFixtureSnapshot(db)
    .bind(retained.source_snapshot_id)
    .first<{ content_digest: string }>();
  expect(snapshot!.content_digest).toBe(await sha256(compressed));
  expect(fetched.map(({ url }) => url)).toEqual([metadataUrl, archiveUrl]);
});

test("an archive URL in the image role cannot activate archive parsing", async () => {
  const { db, run, collect } = await startGraph("scryfall-archive-role-mismatch");
  const [root] = await pendingEvidenceRequests(db, run.id);
  const [wrongRole] = await appendDiscoveredEvidenceRequests(db, run, root!, [
    {
      role: "image",
      url: archiveUrl,
      headers: { accept: "application/gzip" },
    },
  ]);
  await collect(wrongRole!);
  const requests = (await archiveReplayRequests(db).bind(run.id).all<EvidenceRequestRow>()).results;
  expect(requests).toHaveLength(2);
  const retained = requests[1]!;
  expect(retained).toMatchObject({ request_role: "image", state: "failed", failure_code: "source_parse_failed" });
  expect(await archiveQueries.archiveDecodeReceipt(db).bind(retained.source_snapshot_id).first()).toBeNull();
  expect(await archiveQueries.archiveObservationCount(db).bind(retained.source_snapshot_id).first("count")).toBe(0);
  expect(requests[0]).toMatchObject({ request_id: root!.request_id, state: "pending", source_snapshot_id: null });
});
