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
  pauseEvidenceRunOnOwnerRequest,
  resumePausedEvidenceRun,
  recordWorkflowIds,
  parentWorkflowAttemptId,
} from "../../../src/catalogue/source-evidence";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { injectFixtureEvidencePlan } from "../../../test/support/fixture-evidence-plan";
import { retainedTcgdexContexts } from "./query-helpers/tcgdex-retained-graph";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();
// Temporary until parent-context promotion after the actual archive foundation.

test("retained TCGdex bytes preserve a three-ancestor graph through owner pause and interrupted leaf storage", async () => {
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
  const run = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "pokemon",
    source_lineage: "tcgdex-pokemon-en",
    adapter_version: "fixture-tcgdex-retained-graph@1",
    idempotency_key: "retained-tcgdex-parent-graph",
    requests: [{ id: "root", url: captures[0]!.url }],
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
  await collect(captures[0]!.url);
  await collect(captures[1]!.url);
  const setRequests = await pendingEvidenceRequests(database, runId);
  expect(setRequests).toHaveLength(203);
  expect(setRequests.some(({ url }) => url === "https://api.tcgdex.net/v2/en/sets/A1")).toBe(false);
  await collect(captures[2]!.url);
  const planned = await pendingEvidenceRequests(database, runId);
  expect(planned.filter(({ url }) => url.startsWith("https://api.tcgdex.net/v2/en/cards/"))).toHaveLength(10);
  const pause = await pauseEvidenceRunOnOwnerRequest(database, runId, {
    idempotency_key: "pause-retained-tcgdex-graph",
    workflow_instance_id: workflowId,
    workflow_status: "running",
    last_progress_at: null,
  });
  expect(pause.applied).toBe(true);
  expect((await collect(captures[3]!.url)).halt).toEqual({ kind: "run_not_collecting" });
  expect(fetched).toEqual(captures.slice(0, 3).map(({ url }) => url));
  await resumePausedEvidenceRun(database, runId);
  expect((await requiredEvidenceRun(database, runId)).state).toBe("collecting");
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
      qualification: {
        membership: { id: "tk-ex-latia-8", localId: "8" },
        set: { id: "tk-ex-latia", seriesId: "tk", eligibility: "issued_set_candidate" },
        content: { attributes: { card_type: "trainer", hp: null, retreat_cost: null } },
      },
      parent_evidence: contexts
        .slice(0, 3)
        .reverse()
        .map((context) => ({
          snapshotId: context.snapshot_id,
          url: context.request_url,
          retrievedAt: context.retrieved_at,
          contentSha256: context.content_digest,
        })),
    },
  });
  // Discovery is complete for these bodies. The other discovered requests are
  // still pending: this bounded slice cannot claim whole-source coverage.
  expect((await pendingEvidenceRequests(database, runId)).length).toBe(211);
  expect((await requiredEvidenceRun(database, runId)).state).toBe("collecting");
});
