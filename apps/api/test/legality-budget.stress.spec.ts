import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  apiCard,
  apiHeaders,
  canonicalLegalityRuleStatements,
  installApiSuite,
  legalitySourceStatements,
  revisionLegalityRuleStatements,
  seedApiRevision,
  testEnv,
} from "./api-fixtures";

installApiSuite();

test("authenticated Legality Status indexes evidence linearly at the 16,384-rule bound", async () => {
  const revisionId = "catrev_api_legality_maximum_evidence";
  const runId = "run_api_legality_maximum_evidence";
  const cardId = "card_api_legality_maximum_evidence";
  await seedApiRevision({
    revisionId,
    runId,
    cards: [apiCard({
      id: cardId,
      cardNumber: "OP-MAX-001",
      name: "Maximum Evidence",
    })],
  });
  await testEnv.CATALOGUE_DB.batch(legalitySourceStatements({
    runId,
    key: "api_maximum_evidence",
    game: "one-piece",
    profile: "one-piece@1",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@3",
    snapshotId: "srcsnap_api_maximum_evidence",
    observationSetId: "srcset_api_maximum_evidence",
  }));
  const rules = Array.from({ length: 16_384 }, (_, index) => {
    const ordinal = String(index).padStart(5, "0");
    const unresolved = index % 2 === 1;
    return {
      id: `legality_rule_maximum_evidence_${ordinal}`,
      official_id: `maximum-evidence-${ordinal}`,
      game: "one-piece",
      region: "EN-OCEANIA",
      format: "standard",
      event_tier: null,
      effective_from: unresolved ? null : "2026-01-01",
      effective_until: null,
      ...(unresolved
        ? { unresolved_scope: { dimensions: ["effective_interval"] as const } }
        : {}),
      card_ids: [cardId],
      official_wording: unresolved
        ? `Maximum evidence ${ordinal} remains unresolved.`
        : `Maximum evidence ${ordinal} is eligible.`,
      effect: unresolved
        ? { type: "unresolved", reason: `Maximum evidence ${ordinal}` }
        : { type: "eligible" },
      source_lineage: "one-piece-en",
      source_snapshot_id: "srcsnap_api_maximum_evidence",
      source_observation_set_id: "srcset_api_maximum_evidence",
      source_observation_id: "srcobs_api_maximum_evidence",
    };
  });
  for (let offset = 0; offset < rules.length; offset += 64) {
    await testEnv.CATALOGUE_DB.batch(
      canonicalLegalityRuleStatements(revisionId, rules.slice(offset, offset + 64)),
    );
    await testEnv.CATALOGUE_DB.batch(
      revisionLegalityRuleStatements(revisionId, rules.slice(offset, offset + 64)),
    );
  }

  const requestStartedAt = performance.now();
  const response = await exports.default.fetch(new Request(
    "https://card-keepr.invalid/v1/legality-status" +
      `?card_id=${cardId}` +
      "&on=2026-07-30&format=standard&region=EN-OCEANIA&include=evidence",
    { headers: apiHeaders("203.0.113.78") },
  ));
  const requestDurationMs = performance.now() - requestStartedAt;
  expect(response.status).toBe(200);
  // Keep enough headroom for shared CI runners while still rejecting the
  // former quadratic provenance-indexing implementation at the maximum bound.
  expect(requestDurationMs).toBeLessThan(2_000);
  const body = await response.json<{
    data: Array<{
      rule_ids: string[];
      unresolved_scope_rule_ids: string[];
    }>;
    provenance: Record<string, string[]>;
  }>();
  expect(body.data[0]?.rule_ids).toHaveLength(8_192);
  expect(body.data[0]?.unresolved_scope_rule_ids).toHaveLength(8_192);
  expect(body.provenance).toMatchObject({
    "/data/0/rule_ids/0": ["srcobs_api_maximum_evidence"],
    "/data/0/rule_ids/8191": ["srcobs_api_maximum_evidence"],
    "/data/0/unresolved_scope_rule_ids/0": ["srcobs_api_maximum_evidence"],
    "/data/0/unresolved_scope_rule_ids/8191": ["srcobs_api_maximum_evidence"],
  });
}, 120_000);
