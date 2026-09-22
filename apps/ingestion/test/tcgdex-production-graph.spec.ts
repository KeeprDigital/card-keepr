import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import englishBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/english-sets.body?raw";
import pocketBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/pocket-series.body?raw";
import setBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/set-tk-ex-latia.body?raw";
import cardBody from "../../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/card-tk-ex-latia-8.body?raw";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  startEvidenceRun,
  finalizeEvidenceRun,
  recordWorkflowIds,
  parentWorkflowAttemptId,
  appendDiscoveredEvidenceRequests,
} from "../../../src/catalogue/source-evidence";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { tcgdexPokemonSourceAdapterRegistration } from "../../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
import { productionGraphCounts, productionGraphPauses } from "./query-helpers/tcgdex-production-graph";
import { reviewProposals, reviewAllocations } from "./query-helpers/source-admission-evidence";
import { retainedTcgdexContexts } from "./query-helpers/tcgdex-retained-graph";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("production rejects competing Set/local claims for one opaque Card ID while replay and shared images keep one request", async () => {
  const api = "https://api.tcgdex.net/v2/en";
  const cardCount = { total: 1, official: 1 };
  const bodies = new Map<string, unknown>([
    [
      `${api}/sets`,
      [
        { id: "a", cardCount },
        { id: "a-b", cardCount },
      ],
    ],
    [`${api}/series/tcgp`, { id: "tcgp", sets: [] }],
    ...[
      ["a", "b-1"],
      ["a-b", "1"],
    ].map(
      ([id, localId]) =>
        [
          `${api}/sets/${id}`,
          { id, cardCount, serie: { id: "base" }, releaseDate: "1999-01-09", cards: [{ id: "a-b-1", localId }] },
        ] as [string, unknown],
    ),
    [`${api}/cards/a-b-1`, { id: "a-b-1", localId: "b-1", set: { id: "a" }, name: "Test Energy", category: "Energy" }],
  ]);
  const fetched: string[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL) {
      const url = new Request(input).url;
      expect(bodies.has(url)).toBe(true);
      fetched.push(url);
      return Response.json(bodies.get(url));
    },
  } as Fetcher;
  const database = catalogueStore(env.CATALOGUE_DB);
  const started = await startEvidenceRun(database, {
    acquisition_budget: fixtureAcquisitionBudget,
    supported_game: "pokemon",
    source_lineage: "tcgdex-pokemon-en",
    adapter_version: "tcgdex-pokemon-en@1",
    subset: "english-declared-catalogue",
    idempotency_key: "production-competing-membership",
    requests: [
      { id: "tcgdex-pokemon-en:english-set-inventory", url: `${api}/sets`, headers: { accept: "application/json" } },
    ],
  });
  const runId = String(started.id);
  await recordWorkflowIds(database, runId, parentWorkflowAttemptId(runId, 1), []);
  const collect = async (request: Awaited<ReturnType<typeof pendingEvidenceRequests>>[number]) =>
    collectSourceRequestBatch({
      database,
      evidenceObjects: env.EVIDENCE_OBJECTS,
      officialSourceTransport: transport,
      runId,
      hostname: "api.tcgdex.net",
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
      requests: [request],
    });
  await collect((await pendingEvidenceRequests(database, runId))[0]!);
  await collect((await pendingEvidenceRequests(database, runId))[0]!);
  const sets = await pendingEvidenceRequests(database, runId);
  expect(sets.map(({ url }) => url)).toEqual([`${api}/sets/a`, `${api}/sets/a-b`]);
  await collect(sets[0]!);
  const run = await requiredEvidenceRun(database, runId);
  const detail = { role: "detail" as const, url: `${api}/cards/a-b-1`, headers: { accept: "application/json" } };
  const admitted = await appendDiscoveredEvidenceRequests(database, run, sets[0]!, [detail, detail]);
  expect(admitted).toHaveLength(1);
  expect(admitted[0]!.discovered_from_request_id).toBe(sets[0]!.request_id);
  await collect(admitted[0]!);
  await collect(admitted[0]!);
  expect(fetched.filter((url) => url === detail.url)).toHaveLength(1);
  const image = { role: "image" as const, url: "https://assets.tcgdex.net/en/base/base1/98/high.png", headers: {} };
  const shared = await appendDiscoveredEvidenceRequests(database, run, sets[0]!, [image]);
  expect(await appendDiscoveredEvidenceRequests(database, run, sets[1]!, [image, image])).toEqual(shared);
  await collect(sets[1]!);
  expect(await productionGraphCounts(env.CATALOGUE_DB).bind(runId).first()).toEqual({
    planned: 6,
    captured: 5,
    pending: 1,
    failed: 1,
  });
  await expect(appendDiscoveredEvidenceRequests(database, run, sets[1]!, [detail])).rejects.toMatchObject({
    code: "source_discovery_failed",
  });
  expect((await appendDiscoveredEvidenceRequests(database, run, sets[0]!, [detail]))[0]).toMatchObject({
    request_id: admitted[0]!.request_id,
    discovered_from_request_id: sets[0]!.request_id,
  });
  expect(fetched).toEqual([`${api}/sets`, `${api}/series/tcgp`, `${api}/sets/a`, detail.url, `${api}/sets/a-b`]);
});

test("production TCGdex preserves exact retained graph evidence within its census capacity and through interrupted leaf storage", async () => {
  const captures = [
    {
      url: "https://api.tcgdex.net/v2/en/sets",
      body: englishBody,
      sha: "16f34d978327245b5af89c46b6368e7426770905396b8e55c4b9c30664c39556",
    },
    {
      url: "https://api.tcgdex.net/v2/en/series/tcgp",
      body: pocketBody,
      sha: "6f9959038b30271ec4480f1d8929216a78b16fcb6778467471ba4fa91c1a0ded",
    },
    {
      url: "https://api.tcgdex.net/v2/en/sets/tk-ex-latia",
      body: setBody,
      sha: "102e96df35e9680dfd52e71b7b91814931722da8743fd6652f6f8c1e74e366e2",
    },
    {
      url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-8",
      body: cardBody,
      sha: "e279ce0237324cb1c8536ec3d23b58407487fb2c7f426b863647d05e67b84a42",
    },
  ];
  for (const capture of captures) expect(await sha256(utf8(capture.body))).toBe(capture.sha);
  const fetched: string[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      const capture = captures.find(({ url }) => url === request.url);
      if (!capture) throw new Error(`No retained body authorized for ${request.url}`);
      fetched.push(request.url);
      return new Response(capture.body, { headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  const database = catalogueStore(env.CATALOGUE_DB);
  const run = await startEvidenceRun(database, {
    acquisition_budget: fixtureAcquisitionBudget,
    supported_game: "pokemon",
    source_lineage: "tcgdex-pokemon-en",
    adapter_version: "tcgdex-pokemon-en@1",
    subset: "english-declared-catalogue",
    idempotency_key: "production-tcgdex-parent-graph",
    requests: [
      { id: "tcgdex-pokemon-en:english-set-inventory", url: captures[0]!.url, headers: { accept: "application/json" } },
    ],
  });
  const runId = String(run.id),
    workflowId = parentWorkflowAttemptId(runId, 1);
  // Scheduling is controlled; the production run, capture, parse, pause and
  // resume commands persist their own receipts in real D1/R2.
  await recordWorkflowIds(database, runId, workflowId, []);
  const collect = async (url: string, bucket = env.EVIDENCE_OBJECTS) => {
    const request = (await pendingEvidenceRequests(database, runId)).find((item) => item.url === url);
    expect(request).toBeDefined();
    return collectSourceRequestBatch({
      database,
      evidenceObjects: bucket,
      officialSourceTransport: transport,
      runId,
      hostname: "api.tcgdex.net",
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
      requests: [request!],
    });
  };
  const counts = () => productionGraphCounts(env.CATALOGUE_DB).bind(runId).first();
  expect(tcgdexPokemonSourceAdapterRegistration.requestCapacity).toBe(45_000);
  await collect(captures[0]!.url);
  await collect(captures[1]!.url);
  expect((await requiredEvidenceRun(database, runId)).state).toBe("collecting");
  expect(await productionGraphPauses(env.CATALOGUE_DB).bind(runId).all()).toMatchObject({ results: [] });
  expect(await counts()).toEqual({ planned: 205, captured: 2, pending: 203, failed: 0 });
  const setRequests = await pendingEvidenceRequests(database, runId);
  expect(setRequests).toHaveLength(203);
  expect(setRequests.some(({ url }) => url === "https://api.tcgdex.net/v2/en/sets/A1")).toBe(false);
  await collect(captures[2]!.url);
  expect(fetched).toEqual(captures.slice(0, 3).map(({ url }) => url));
  expect(await counts()).toEqual({ planned: 215, captured: 3, pending: 212, failed: 0 });
  const planned = await pendingEvidenceRequests(database, runId);
  expect(planned.filter(({ url }) => url.startsWith("https://api.tcgdex.net/v2/en/cards/"))).toHaveLength(10);
  let interrupted = false;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (!interrupted && args[0].startsWith("source-observations/")) {
            interrupted = true;
            throw new Error("lost retained TCGdex leaf observation acknowledgement");
          }
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(collect(captures[3]!.url, bucket)).rejects.toThrow(
    "lost retained TCGdex leaf observation acknowledgement",
  );
  expect(interrupted).toBe(true);
  await collect(captures[3]!.url);
  expect(fetched).toEqual(captures.map(({ url }) => url));
  const contexts = (
    await retainedTcgdexContexts(env.CATALOGUE_DB).bind(runId).all<{
      request_url: string;
      dependency_count: number;
      observation_set_id: string;
      snapshot_id: string;
      retrieved_at: string;
      content_digest: string;
      state: string;
    }>()
  ).results;
  expect(contexts.map((context) => [context.request_url, context.dependency_count, context.state])).toEqual(
    captures.map(({ url }, index) => [url, index, "finalized"]),
  );
  const observation = await readSourceObservation(database, contexts[3]!.observation_set_id, 0);
  expect(observation).toMatchObject({
    value: {
      card: { game: "pokemon", name: "Potion" },
      card_identity_evidence: { source_design_key: "tk-ex-latia-8" },
      printing: { game_data: { attributes: { set_code: "tk-ex-latia", collector_number: "8" } } },
      appearance_evidence: { images: [] },
    },
  });
  expect(await counts()).toEqual({ planned: 215, captured: 4, pending: 211, failed: 0 });
  expect(await reviewProposals(database).bind("tcgdex-pokemon-en").all()).toMatchObject({ results: [] });
  expect(await reviewAllocations(database).all()).toMatchObject({ results: [] });
  await finalizeEvidenceRun(database, runId);
  // Discovery is complete for these bodies. The other discovered requests are
  // still pending: this bounded slice cannot claim whole-source coverage.
  expect((await pendingEvidenceRequests(database, runId)).length).toBe(211);
  expect((await requiredEvidenceRun(database, runId)).state).toBe("collecting");
});
