import { expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  RequestCapacityProblem,
} from "../../../src/catalogue/source-evidence";
import {
  capacityPageUrl,
  capacityPrintingsPerPage,
  syntheticCapacityTiers,
} from "../../../test/support/fake-publisher/capacity-workloads";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { installRuntimeSuite, showCollection } from "./runtime-helpers";

installRuntimeSuite();

// Admission-only measurement. No source body or image is fetched in these
// cases. Passing assertions establish the actual graph guard outcome, never
// usable capacity for the intended 5/50 GiB retained workload.
test.each(syntheticCapacityTiers)(
  "$id records its actual request-graph admission outcome",
  async (tier) => {
    const pages = tier.printings / capacityPrintingsPerPage;
    const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: `capacity-${tier.id}`,
      requests: [{ id: "root", method: "GET", url: capacityPageUrl(tier.id, 0) }],
    });
    const id = String(created.id);
    const store = catalogueStore(env.CATALOGUE_DB);
    const run = await requiredEvidenceRun(store, id);
    const parent = (await pendingEvidenceRequests(store, id))[0]!;
    const requests = Array.from({ length: pages - 1 }, (_, index) => ({
      role: "listing" as const,
      url: capacityPageUrl(tier.id, index + 1),
      headers: { accept: "application/json" },
    }));
    const started = Date.now();
    let error: unknown;
    try {
      await appendDiscoveredEvidenceRequests(store, run, parent, requests);
    } catch (caught) {
      error = caught;
    }
    const elapsed = Date.now() - started;
    const current = await showCollection(id);
    const status = current.collection as {
      requests: { total: number };
      evidence: { snapshot_count: number };
      capacity: { required_capacity: number | null }[];
    };
    expect(status.evidence.snapshot_count).toBe(0);
    if (tier.id === "tier-1") {
      expect(error).toBeUndefined();
      expect(current.state).toBe("collecting");
      expect(status.requests.total).toBe(pages);
    } else {
      expect(error).toBeInstanceOf(RequestCapacityProblem);
      expect(error).toMatchObject({
        code: "source_discovery_too_large",
        capacity: { required_capacity: pages, used_capacity: 1, request_capacity: 5000 },
      });
      // This repository rejects admission; the collection driver owns the
      // durable pause, covered separately by runtime-capacity-resume.
      expect(current.state).toBe("collecting");
      expect(status.requests.total).toBe(1);
      expect(status.capacity[0]!.required_capacity).toBeNull();
    }
    console.info(
      JSON.stringify({
        contract: "card-keepr-synthetic-tier-admission@1",
        planned: { ...tier, source_pages: pages },
        measured: {
          elapsed_ms: elapsed,
          admitted_source_requests: status.requests.total,
          captured_source_bytes: 0,
          retained_image_bytes: 0,
          parsed_printings: 0,
          state: current.state,
        },
        outcome:
          tier.id === "tier-1"
            ? "graph_admitted_retained_pipeline_not_exercised"
            : "request_capacity_guard_rejection_not_usable_capacity",
      }),
    );
  },
  60_000,
);
