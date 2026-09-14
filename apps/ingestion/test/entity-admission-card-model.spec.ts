import { expect, test } from "vitest";
import contract from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { catalogueStore, canonicalJson } from "../../../src/catalogue/shared";
import { allocatedIdentityStatement } from "../../../src/catalogue/reconciliation/canonical-identity-repository";
import {
  insertAdmissionDecisionStatement,
  proposalHistoryStatement,
} from "../../../src/catalogue/reconciliation/entity-admission-repository";
import { get, installReconciliationSuite, post, testEnv } from "./reconciliation-helpers";
import { retainUnattributedCardAllocation } from "./query-helpers/card-model-admission";

installReconciliationSuite();

// Synthetic owner intake exercises identity decisions, not publisher evidence.
function sourceCard(category: "gameplay" | "token" | "art") {
  return {
    game: "riftbound",
    official_identity: { kind: "publisher_name", value: "Shared owner identity" },
    name: "Shared owner identity",
    effective_rules_text: null,
    ...(category === "art" ? { category } : {}),
    game_data: {
      profile: "riftbound@1",
      attributes:
        category === "art"
          ? {}
          : {
              card_types: ["unit"],
              supertypes: category === "token" ? ["token"] : [],
              domains: ["fury"],
              energy: 2,
              power: null,
              might: 3,
              might_bonus: null,
              tags: [],
              ability_text: null,
              effect_text: null,
            },
    },
  };
}

async function propose(category: "gameplay" | "token" | "art", key: string) {
  const created = await post("/v1/entity-proposals", {
    game: "riftbound",
    source_lineage: "owner",
    reference: key,
    content: { card: sourceCard(category) },
    evidence: { attestation: "Synthetic personal inspection of an issued Card." },
    idempotency_key: key,
  });
  expect(created.response.status).toBe(201);
  return String(created.document.id);
}

test("owner admits gameplay and art Cards with the same official identity as separate allocations", async () => {
  const ids: string[] = [];
  for (const category of ["gameplay", "art"] as const) {
    const proposal = await propose(category, `shared-${category}`);
    const input = {
      action: "admit",
      expected_generation: "0",
      rationale: "Inspected distinct issued Card designs",
      idempotency_key: `admit-${category}`,
    };
    const admitted = await post(`/v1/entity-proposals/${proposal}/decisions`, input);
    expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
    const history = admitted.document.history as { decision: { card: { id: string; category: string } } }[];
    expect(history[0]!.decision.card.category).toBe(category);
    ids.push(history[0]!.decision.card.id);
    expect((await post(`/v1/entity-proposals/${proposal}/decisions`, input)).document).toEqual(admitted.document);
  }
  expect(new Set(ids).size).toBe(2);
  const duplicate = await propose("art", "duplicate-art");
  const refused = await post(`/v1/entity-proposals/${duplicate}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "The same category and identity already exists",
    idempotency_key: "duplicate-art-admit",
  });
  expect(refused.response.status).toBe(422);
  expect(refused.document.code).toBe("admission_identity_already_exists");
});

test.each(["gameplay", "token"] as const)(
  "owner replays and reaffirms a retained %s decision without rewriting its allocation or history",
  async (category) => {
    const proposal = await propose(category, "retained-proposal");
    const input = {
      action: "admit",
      expected_generation: "0",
      rationale: "Historical personal inspection",
      idempotency_key: "retained-admission",
    };
    const card = { ...sourceCard(category), id: "card_retained_owner" };
    const decision = { card, printing: null, exception: null, warnings: [], new_card: true, linked: false };
    const database = catalogueStore(testEnv.CATALOGUE_DB);
    const allocationKey = canonicalJson(["card", [card.game, card.official_identity]]);
    // Seed the immutable pre-expansion decision through its actual storage boundary.
    await insertAdmissionDecisionStatement(
      database,
      {
        proposal_id: proposal,
        generation: 1,
        action: "admit",
        actor: "owner",
        rationale: input.rationale,
        decision_json: canonicalJson(decision),
        idempotency_key: input.idempotency_key,
        request_json: canonicalJson({ id: proposal, ...input }),
        decided_at: "2026-09-01T00:00:00.000Z",
      },
      undefined,
      [{ key: allocationKey, id: card.id, kind: "card" }],
    ).run();
    const retained = await proposalHistoryStatement(database, proposal).first();
    const replay = await post(`/v1/entity-proposals/${proposal}/decisions`, input);
    expect(replay.response.status).toBe(200);
    await assertHttpResponse(
      contract,
      "/v1/entity-proposals/{proposal}/decisions",
      "post",
      replay.response,
      replay.document,
    );
    expect(replay.document.history).toEqual([expect.objectContaining({ decision })]);
    const reconsidered = await post(`/v1/entity-proposals/${proposal}/decisions`, {
      action: "reconsider",
      expected_generation: "1",
      rationale: "Reinspect the same issued identity",
      idempotency_key: "reconsider-retained",
    });
    expect(reconsidered.response.status).toBe(200);
    const reaffirmed = await post(`/v1/entity-proposals/${proposal}/decisions`, {
      ...input,
      expected_generation: "2",
      idempotency_key: "reaffirm-retained",
    });
    expect(reaffirmed.response.status, JSON.stringify(reaffirmed.document)).toBe(200);
    await assertHttpResponse(
      contract,
      "/v1/entity-proposals/{proposal}/decisions",
      "post",
      reaffirmed.response,
      reaffirmed.document,
    );
    expect(reaffirmed.document.history).toEqual([
      expect.objectContaining({ decision }),
      expect.objectContaining({
        action: "reconsider",
        decision: { content: { card: sourceCard(category) }, evidence: expect.any(Object) },
      }),
      expect.objectContaining({
        decision: expect.objectContaining({
          card: expect.objectContaining({ id: card.id, category, gameplay_applicability: "applicable" }),
          new_card: false,
        }),
      }),
    ]);
    expect(await proposalHistoryStatement(database, proposal).first()).toEqual(retained);
    expect(await allocatedIdentityStatement(database, allocationKey).first()).toEqual({ entity_id: card.id });
    expect((await get(`/v1/entity-proposals/${proposal}`)).document.generation).toBe(3);
    if (category === "token") {
      const gameplayProposal = await propose("gameplay", "gameplay-beside-retained-token");
      const gameplay = await post(`/v1/entity-proposals/${gameplayProposal}/decisions`, {
        action: "admit",
        expected_generation: "0",
        rationale: "A separate gameplay Card uses the same publisher identity",
        idempotency_key: "admit-gameplay-beside-retained-token",
      });
      expect(gameplay.response.status, JSON.stringify(gameplay.document)).toBe(200);
      const history = gameplay.document.history as { decision: { card: { id: string } } }[];
      expect(history[0]!.decision.card.id).not.toBe(card.id);
      expect(await allocatedIdentityStatement(database, allocationKey).first()).toEqual({ entity_id: card.id });
    }
  },
);

test.each(["gameplay", "token", "art"] as const)(
  "owner cannot assign or replace an unattributed legacy allocation as %s",
  async (category) => {
    const card = sourceCard(category);
    const legacyKey = canonicalJson(["card", [card.game, card.official_identity]]);
    await retainUnattributedCardAllocation(testEnv.CATALOGUE_DB).bind(legacyKey).run();
    const proposal = await propose(category, "unattributed-proposal");
    const result = await post(`/v1/entity-proposals/${proposal}/decisions`, {
      action: "admit",
      expected_generation: "0",
      rationale: "The older identity needs attribution",
      idempotency_key: "unattributed-admit",
    });
    expect(result.response.status).toBe(409);
    expect(result.document.code).toBe("canonical_card_allocation_unresolved");
    const inspected = await get(`/v1/entity-proposals/${proposal}`);
    expect(inspected.document).toMatchObject({ generation: 0, history: [] });
    const database = catalogueStore(testEnv.CATALOGUE_DB);
    expect(await allocatedIdentityStatement(database, legacyKey).first()).toEqual({ entity_id: "card_unattributed" });
    expect(
      await allocatedIdentityStatement(
        database,
        canonicalJson(["card", [card.game, card.official_identity, card.game_data.profile, category]]),
      ).first(),
    ).toBeNull();
  },
);
