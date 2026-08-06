import { expect, test } from "vitest";
import {
  installContextualLegalitySuite,
  productionFusionLegalityRequests,
  request,
  requiredString,
  waitForState,
} from "./contextual-legality-helpers";

installContextualLegalitySuite();

test.each([
  "card-keepr-mixed-modeled-unmodeled-legality-v3",
  "card-keepr-residual-paragraph-legality-v3",
  "card-keepr-residual-div-legality-v3",
  "card-keepr-residual-synonym-legality-v3",
  "card-keepr-unrepresentable-legality-v3",
  "card-keepr-mixed-effect-legality-v3",
  "card-keepr-residual-semantics-legality-v3",
  "card-keepr-definitive-unresolved-legality-v3",
  "card-keepr-missing-combination-side-v3",
  "card-keepr-mismatched-legality-total-v3",
  "card-keepr-truncated-legality-partition-v3",
  "card-keepr-conditional-legality-v3",
  "card-keepr-conditional-when-legality-v3",
  "card-keepr-conditional-if-legality-v3",
  "card-keepr-conditional-during-legality-v3",
  "card-keepr-conditional-only-legality-v3",
  "card-keepr-wording-target-omitted-v3",
  "card-keepr-wording-target-mismatch-v3",
  "card-keepr-wording-global-targeted-v3",
  "card-keepr-wording-region-mismatch-v3",
  "card-keepr-wording-region-prefix-mismatch-v3",
  "card-keepr-wording-format-mismatch-v3",
  "card-keepr-wording-tier-omitted-v3",
  "card-keepr-wording-tier-mismatch-v3",
  "card-keepr-multiple-date-release-v3",
])("a versioned production adapter blocks official wording it cannot represent exactly: %s", async (marker) => {
  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@4",
    idempotency_key: `production-unrepresentable-legality-v3-${marker}`,
    requests: productionFusionLegalityRequests(
      marker,
    ),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);
  expect(await waitForState(runId, "failed")).toMatchObject({
    state: "failed",
  });
  expect((await request(`/v1/ingestion-runs/${runId}/candidate`)).response.status)
    .toBe(409);
}, 90_000);

