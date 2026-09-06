import { expect, test } from "vitest";
import {
  installReconciliationSuite,
  post,
  get,
  collect,
  reconcile,
  approve,
  exportComponentRecords,
} from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic owner attestations exercise decisions; they are not real-source findings.
test("reviewed Card merge retains its decision and changes only a newly approved revision", async () => {
  const seed = await reconcile((await collect("/reconciliation/card-without-printing", "correction-seed")).id);
  const publication = await approve(seed.document);
  expect(publication.response.status, JSON.stringify(publication.document)).toBe(200);
  const revision = String(publication.document.resulting_revision_id);
  const cards = await exportComponentRecords(revision, "cards");
  const original = cards[0]!;
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-duplicate",
    content: {
      card: {
        ...original,
        id: undefined,
        type: undefined,
        lifecycle: undefined,
        official_identity: { kind: "unknown", value: null },
      },
    },
    evidence: { attestation: "Synthetic duplicate inspected by owner" },
    idempotency_key: "duplicate",
  });
  const admission = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Synthetic duplicate initially admitted",
    idempotency_key: "duplicate-admit",
  });
  expect(admission.response.status, JSON.stringify(admission.document)).toBe(200);
  const duplicate = (admission.document.history as { decision: { card: { id: string } } }[])[0]!.decision.card.id;
  const next = await reconcile((await collect("/reconciliation/card-without-printing", "duplicate-publish")).id);
  const published = await approve(next.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const expected = String(published.document.resulting_revision_id);
  const proposal = {
    game: "one-piece",
    entity_kind: "card",
    action: "merge",
    source_ids: [duplicate],
    replacement_ids: [original.id],
    printing_assignments: {},
    expected_current_revision_id: expected,
    rationale: "Owner establishes the same rules-level Card",
    evidence: { attestation: "Synthetic comparison of both retained identities" },
  };
  const validation = await post("/v1/identity-corrections/validate", proposal);
  expect(validation.response.status, JSON.stringify(validation.document)).toBe(200);
  const request = { ...proposal, review_digest: validation.document.review_digest, idempotency_key: "merge" };
  const decision = await post("/v1/identity-corrections", request);
  expect(decision.response.status, JSON.stringify(decision.document)).toBe(201);
  expect((await post("/v1/identity-corrections", request)).document.id).toBe(decision.document.id);
  expect((await get(`/v1/identity-corrections/${decision.document.id}`)).document).toMatchObject({
    action: "merge",
    source_ids: [duplicate],
  });
  const corrected = await reconcile((await collect("/reconciliation/card-without-printing", "merge-publish")).id);
  const accepted = await approve(corrected.document);
  expect(accepted.response.status, JSON.stringify(accepted.document)).toBe(200);
  const current = String(accepted.document.resulting_revision_id);
  expect(await exportComponentRecords(current, "cards")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: duplicate })]),
  );
  expect(await exportComponentRecords(current, "identity-corrections")).toEqual([
    expect.objectContaining({ id: duplicate, action: "merge", replacement_ids: [original.id] }),
  ]);
  expect(await exportComponentRecords(expected, "cards")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: duplicate })]),
  );
});

async function admitSyntheticPrinting(reference: string) {
  const card = {
    game: "one-piece",
    official_identity: { kind: "unknown", value: null },
    name: reference,
    effective_rules_text: null,
    game_data: {
      profile: "one-piece@1",
      attributes: {
        card_type: "character",
        colours: ["red"],
        cost: 1,
        life: null,
        battle_attributes: [],
        power: 1000,
        counter: null,
        traits: [],
        block_icons: [],
        effect_text: null,
        trigger_text: null,
      },
    },
  };
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference,
    content: {
      card,
      printing: {
        rarity: { raw: null, normalized: null },
        printed_rules_text: null,
        game_data: { profile: "one-piece@1", attributes: { illustration_types: [] } },
      },
    },
    evidence: { attestation: "Synthetic owner inspection" },
    idempotency_key: reference,
  });
  const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Synthetic distinct issued printing",
    exception: { scope: ["identity"], attestation: "Synthetic distinct artwork inspection" },
    idempotency_key: `${reference}-admit`,
  });
  expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
  return (admitted.document.history as { decision: { card: { id: string }; printing: { id: string } } }[])[0]!.decision;
}

test("Printing split publishes all replacements and never chooses a consumer-owned variant", async () => {
  const original = await admitSyntheticPrinting("synthetic-conflated");
  const left = await admitSyntheticPrinting("synthetic-left");
  const right = await admitSyntheticPrinting("synthetic-right");
  const seed = await approve(
    (await reconcile((await collect("/reconciliation/card-without-printing", "split-seed")).id)).document,
  );
  expect(seed.response.status, JSON.stringify(seed.document)).toBe(200);
  const revision = String(seed.document.resulting_revision_id);
  const proposal = {
    game: "one-piece",
    entity_kind: "printing",
    action: "split",
    source_ids: [original.printing.id],
    replacement_ids: [left.printing.id, right.printing.id],
    printing_assignments: {},
    expected_current_revision_id: revision,
    rationale: "Owner reviewed two distinct issued variants",
    evidence: { attestation: "Synthetic side-by-side physical inspection" },
  };
  const reviewed = await post("/v1/identity-corrections/validate", proposal);
  expect(reviewed.response.status, JSON.stringify(reviewed.document)).toBe(200);
  const decided = await post("/v1/identity-corrections", {
    ...proposal,
    review_digest: reviewed.document.review_digest,
    idempotency_key: "split",
  });
  expect(decided.response.status).toBe(201);
  const next = await reconcile((await collect("/reconciliation/card-without-printing", "split-next")).id);
  const published = await approve(next.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const current = String(published.document.resulting_revision_id);
  expect(await exportComponentRecords(current, "identity-corrections")).toEqual([
    {
      type: "identity_correction",
      id: original.printing.id,
      game: "one-piece",
      entity_kind: "printing",
      action: "split",
      replacement_ids: [left.printing.id, right.printing.id],
    },
  ]);
  const printings = await exportComponentRecords(current, "printings");
  expect(printings).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: original.printing.id })]));
  expect(printings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: left.printing.id }),
      expect.objectContaining({ id: right.printing.id }),
    ]),
  );
  expect(await exportComponentRecords(revision, "printings")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: original.printing.id })]),
  );
});

test("Card split requires reviewed catalogue Printing assignments and preserves their IDs", async () => {
  const original = await admitSyntheticPrinting("card-split-conflated");
  const left = await admitSyntheticPrinting("card-split-left");
  const right = await admitSyntheticPrinting("card-split-right");
  const published = await approve(
    (await reconcile((await collect("/reconciliation/card-without-printing", "card-split-seed")).id)).document,
  );
  const proposal = {
    game: "one-piece",
    entity_kind: "card",
    action: "split",
    source_ids: [original.card.id],
    replacement_ids: [left.card.id, right.card.id],
    printing_assignments: {},
    expected_current_revision_id: published.document.resulting_revision_id,
    rationale: "Owner separates conflated rules-level Cards",
    evidence: { attestation: "Synthetic inspection of rules-level identity" },
  };
  const unassigned = await post("/v1/identity-corrections/validate", proposal);
  expect(unassigned.response.status).toBe(422);
  const assigned = { ...proposal, printing_assignments: { [original.printing.id]: left.card.id } };
  const reviewed = await post("/v1/identity-corrections/validate", assigned);
  expect(reviewed.response.status, JSON.stringify(reviewed.document)).toBe(200);
  const wrongDigest = await post("/v1/identity-corrections", {
    ...assigned,
    review_digest: "0".repeat(64),
    idempotency_key: "card-split",
  });
  expect(wrongDigest.response.status).toBe(409);
  const accepted = await post("/v1/identity-corrections", {
    ...assigned,
    review_digest: reviewed.document.review_digest,
    idempotency_key: "card-split",
  });
  expect(accepted.response.status, JSON.stringify(accepted.document)).toBe(201);
  const corrected = await approve(
    (await reconcile((await collect("/reconciliation/card-without-printing", "card-split-publish")).id)).document,
  );
  expect(corrected.response.status, JSON.stringify(corrected.document)).toBe(200);
  const printings = await exportComponentRecords(String(corrected.document.resulting_revision_id), "printings");
  expect(printings).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: original.printing.id, card_id: left.card.id })]),
  );
  expect(printings.some((p) => p.card_id === original.card.id)).toBe(false);
});
