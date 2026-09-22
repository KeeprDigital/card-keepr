import * as sourceEvidenceQueries from "./query-helpers/source-evidence";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  type CollectionDocument,
  fixtureEvidenceRequest,
  installRuntimeSuite,
  waitForEvidenceCondition,
} from "./runtime-helpers";

installRuntimeSuite();

type RequestRow = {
  request_id: string;
  request_role: string;
  url: string;
  state: string;
  failure_code: string | null;
  discovered_from_request_id: string | null;
};

// A page request is discovered from the root; its response is chosen by path
// on the fake publisher (test/support/fake-publisher/failure-injection.ts).
async function collect(key: string, pagePath: string, expectedState: string) {
  const response = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: key,
    requests: [
      { id: "root", url: "https://official-source.invalid/cards" },
      { id: "page", url: `https://official-source.invalid${pagePath}` },
    ],
  });
  expect(response.status).toBe(201);
  const run = await response.json<CollectionDocument>();
  const accepted = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const settled = await waitForEvidenceCondition(
    run.id,
    (current) =>
      expectedState === "collected" ? current.collection_completed_at !== null : current.state === expectedState,
    15_000,
  );
  const requests = (
    await sourceEvidenceQueries.readSourceRequestsForRedirectDiscovery(env.CATALOGUE_DB).bind(run.id).all<RequestRow>()
  ).results;
  return { settled, requests };
}

test("a same-site redirect is retained as evidence and discovers its Location once", async () => {
  const { settled, requests } = await collect("redirect_discovery_same_site_001", "/moved.php", "collected");
  // Collection completes: the redirected request is tolerated because its
  // content continues in the discovered request. (This synthetic fixture's
  // later reconciliation outcome is outside the collection contract.)
  expect(settled.collection_completed_at).not.toBeNull();
  expect(settled.failure_code === null || !settled.failure_code.startsWith("source_")).toBe(true);
  const moved = requests.find((request) => request.url === "https://official-source.invalid/moved.php")!;
  expect(moved).toMatchObject({
    request_role: "listing",
    state: "failed",
    failure_code: "source_request_redirect_discovered",
  });
  const target = requests.find((request) => request.url === "https://official-source.invalid/moved/")!;
  expect(target).toMatchObject({
    request_role: "listing",
    state: "observed",
    failure_code: null,
    discovered_from_request_id: moved.request_id,
  });
  // The redirect response itself is the moved request's retained evidence,
  // never a Source Snapshot of the original URL.
  expect(settled.snapshots.map(({ request }) => request.url).sort()).toEqual([
    "https://official-source.invalid/cards",
    "https://official-source.invalid/moved/",
  ]);
  expect(settled.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ outcome: "redirect", http_status: 301 })]),
  );
  // Every physical call, the redirect included, is charged to the budget.
  expect((settled as CollectionDocument & { acquisition: unknown }).acquisition).toMatchObject({
    charged_dispatches: 3,
  });
  await clearActiveRunForNextScenario();
}, 30_000);

test("a redirect from a redirect-discovered request fails as before (one hop)", async () => {
  const { settled, requests } = await collect("redirect_discovery_second_hop_001", "/redirect-twice", "failed");
  expect(settled).toMatchObject({ state: "failed", failure_code: "source_redirect_rejected" });
  const first = requests.find((request) => request.url === "https://official-source.invalid/redirect-twice")!;
  expect(first).toMatchObject({ state: "failed", failure_code: "source_request_redirect_discovered" });
  expect(requests.find((request) => request.discovered_from_request_id === first.request_id)).toMatchObject({
    url: "https://official-source.invalid/redirect",
    state: "failed",
    failure_code: "source_redirect_rejected",
  });
  await clearActiveRunForNextScenario();
}, 30_000);

test("a cross-site redirect still fails the page request", async () => {
  const { settled, requests } = await collect("redirect_discovery_cross_site_001", "/redirect-cross-site", "failed");
  expect(settled).toMatchObject({ state: "failed", failure_code: "source_redirect_rejected" });
  expect(requests.some((request) => request.url.startsWith("https://elsewhere.invalid/"))).toBe(false);
  await clearActiveRunForNextScenario();
}, 30_000);
