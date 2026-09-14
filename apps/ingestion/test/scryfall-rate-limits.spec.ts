import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test.each([
  { header: null, minimum: 30000 },
  { header: "1", minimum: 30000 },
  { header: "120", minimum: 120000 },
])("Scryfall HTTP 429 retains at least its documented cooldown (Retry-After $header)", async ({ header, minimum }) => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const started = await startEvidenceRun(database, {
    supported_game: "magic",
    source_lineage: adapter.sourceLineage,
    adapter_version: adapter.adapterVersion,
    idempotency_key: `scryfall-429-${header}`,
    requests: adapter.requiredSurfaces!.map((surface) => ({
      id: `${adapter.sourceLineage}:${surface}`,
      url: adapter.requestUrlForSurface!(surface),
      headers: { accept: "application/json", "user-agent": "Card-Keepr test" },
    })),
  });
  let requests = 0;
  const transport = {
    async fetch() {
      requests++;
      return new Response("Rate limited", { status: 429, headers: header === null ? {} : { "retry-after": header } });
    },
  } as unknown as Fetcher;
  const result = await collectSourceRequestBatch({
    database,
    evidenceObjects: testEnv.EVIDENCE_OBJECTS,
    officialSourceTransport: transport,
    runId: String(started.id),
    hostname: "api.scryfall.com",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests: (await pendingEvidenceRequests(database, String(started.id))).slice(0, 1),
  });
  expect(requests).toBe(1);
  expect(result.halt).toMatchObject({ kind: "retry_wait", wait_ms: minimum });
});
