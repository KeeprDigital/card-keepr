import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import { runReconciliationWorkflow } from "../src/reconciliation-workflow";
import {
  installReconciliationSuite,
  post,
  get,
  collect,
  reconcile,
  approve,
  exportComponentRecords,
  postFixtureEvidence,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic owner intake, not retained evidence that this Card exists in the world.
test("owner retains incomplete intake, rejects and explicitly reconsiders without erasing history", async () => {
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-intake-1",
    content: { card: { name: "Synthetic incomplete Card" } },
    evidence: { attestation: "Synthetic test of owner personal inspection." },
    idempotency_key: "proposal-1",
  });
  expect(created.response.status).toBe(201);
  const id = String(created.document.id);
  expect(created.document).toMatchObject({ status: "unresolved", generation: 0 });
  const rejected = await post(`/v1/entity-proposals/${id}/decisions`, {
    action: "reject",
    expected_generation: "0",
    rationale: "Identity not established",
    idempotency_key: "reject-1",
  });
  expect(rejected.document).not.toHaveProperty("code");
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({ status: "rejected", generation: 1 });
  const reconsidered = await post(`/v1/entity-proposals/${id}/decisions`, {
    action: "reconsider",
    expected_generation: "1",
    rationale: "Owner will inspect again",
    idempotency_key: "reconsider-1",
  });
  expect(reconsidered.response.status).toBe(200);
  const inspected = await get(`/v1/entity-proposals/${id}`);
  expect(inspected.document).toMatchObject({ status: "unresolved", generation: 2 });
  expect(inspected.document.history).toEqual([
    expect.objectContaining({ action: "reject", rationale: "Identity not established" }),
    expect.objectContaining({ action: "reconsider", rationale: "Owner will inspect again" }),
  ]);
});

const syntheticCard = {
  game: "one-piece",
  official_identity: { kind: "unknown", value: null },
  name: "Synthetic owner card",
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

test("attested admission preserves unknown number and cannot waive required game structure", async () => {
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-valid",
    content: { card: syntheticCard },
    evidence: { attestation: "Synthetic personal inspection of real-card identity." },
    idempotency_key: "valid-proposal",
  });
  const id = String(created.document.id);
  const admitted = await post(`/v1/entity-proposals/${id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Identity established by personal inspection",
    exception: { scope: ["source_evidence", "identity"], attestation: "Synthetic inspected card, distinct identity." },
    idempotency_key: "admit-valid",
  });
  expect(admitted.document, JSON.stringify(admitted.document)).not.toHaveProperty("code");
  expect(admitted.response.status).toBe(200);
  expect(admitted.document).toMatchObject({ status: "admitted", generation: 1 });
  const invalid = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-invalid",
    content: {
      card: {
        ...syntheticCard,
        game_data: { ...syntheticCard.game_data, attributes: { ...syntheticCard.game_data.attributes, cost: null } },
      },
    },
    evidence: { attestation: "Synthetic inspection" },
    idempotency_key: "invalid-proposal",
  });
  const refused = await post(`/v1/entity-proposals/${invalid.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Attempt to waive required structure",
    exception: { scope: ["source_evidence", "identity"], attestation: "Synthetic inspection" },
    idempotency_key: "admit-invalid",
  });
  expect(refused.response.status).toBe(422);
});

test("owner admission enters the next candidate and consumer catalogue only after approval", async () => {
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-publish",
    content: { card: syntheticCard },
    evidence: { attestation: "Synthetic personal inspection." },
    idempotency_key: "publish-proposal",
  });
  const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Inspected synthetic fixture",
    idempotency_key: "publish-admit",
  });
  expect(admitted.response.status).toBe(200);
  const history = admitted.document.history as { decision: { card: { id: string } } }[];
  const cardId = history[0]!.decision.card.id;
  const run = await collect("/reconciliation/card-without-printing", "admission-publish");
  const candidate = await reconcile(run.id);
  expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
  expect(candidate.document.warnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "entity_admission" })]),
  );
  const published = await approve(candidate.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const cards = await exportComponentRecords(String(published.document.resulting_revision_id), "cards");
  expect(cards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: cardId,
        name: "Synthetic owner card",
        official_identity: { kind: "unknown", value: null },
      }),
    ]),
  );
});

test("owner admissions enter a candidate through inspectable bounded preparation groups", async () => {
  for (let index = 0; index < 32; index++) {
    const created = await post("/v1/entity-proposals", {
      game: "one-piece",
      source_lineage: "owner",
      reference: `bounded-admission-${index}`,
      content: { card: { ...syntheticCard, name: `Synthetic admitted Card ${index}` } },
      evidence: { attestation: "Synthetic personal inspection." },
      idempotency_key: `bounded-proposal-${index}`,
    });
    expect(created.response.status).toBe(201);
    expect(
      (
        await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
          action: "admit",
          expected_generation: "0",
          rationale: "Inspected synthetic fixture",
          idempotency_key: `bounded-admit-${index}`,
        })
      ).response.status,
    ).toBe(200);
  }
  const run = await collect("/reconciliation/card-without-printing", "bounded-admission-publish");
  let calls = 0;
  const admissionCalls: number[] = [];
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        const value = Reflect.get(target, property);
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            calls++;
            return Reflect.apply(value, target, args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (property === "batch")
        return (...args: Parameters<D1Database["batch"]>) => {
          calls++;
          return target.batch(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: String(run.document.expected_current_revision_id),
        idempotency_key: `reconcile-${run.id}`,
        observed_at: new Date().toISOString(),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
        calls = 0;
        const result = await callback();
        if (JSON.parse(result).continuation?.phase === "entity_admissions") admissionCalls.push(calls);
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect(admissionCalls.length).toBeGreaterThanOrEqual(8);
  expect(Math.max(...admissionCalls)).toBeLessThanOrEqual(100);
  const candidate = await get(`/v1/ingestion-runs/${run.id}/candidate`);
  expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
  const partitions = (await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`)).document.partitions as {
    kind: string;
    record_count: number;
  }[];
  expect(partitions.filter(({ kind }) => kind === "cards").reduce((sum, part) => sum + part.record_count, 0)).toBe(33);
  const status = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
  const checkpoint = (status.checkpoints as { phase: string; ordinal: number; cursor: unknown }[]).find(
    ({ phase }) => phase === "entity_admissions",
  );
  expect(checkpoint).toMatchObject({ cursor: { complete: true, processedDecisions: 32 } });
  expect(checkpoint!.ordinal).toBeGreaterThanOrEqual(7);
  const published = await approve(candidate.document);
  expect(published.response.status).toBe(200);
  const cards = await exportComponentRecords(String(published.document.resulting_revision_id), "cards");
  expect(cards).toHaveLength(33);
  expect(cards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "Synthetic admitted Card 0" }),
      expect.objectContaining({ name: "Synthetic admitted Card 31" }),
    ]),
  );
});

test("manual Printing admission identifies its Card and retains a scoped attestation without fake image proof", async () => {
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "synthetic-printing",
    content: {
      card: syntheticCard,
      printing: {
        rarity: { raw: null, normalized: null },
        printed_rules_text: null,
        game_data: { profile: "one-piece@1", attributes: { illustration_types: [] } },
      },
    },
    evidence: { attestation: "Synthetic personal inspection of a distinct physical printing." },
    idempotency_key: "printing-proposal",
  });
  const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Owner resolves Card and Printing identity",
    exception: { scope: ["identity", "source_evidence"], attestation: "Synthetic inspection of actual printing." },
    idempotency_key: "printing-admit",
  });
  expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
  const decision = (
    admitted.document.history as { decision: { card: { id: string }; printing: { card_id: string } } }[]
  )[0]!.decision;
  expect(decision.printing.card_id).toBe(decision.card.id);
  const candidate = await reconcile((await collect("/reconciliation/card-without-printing", "printing-publish")).id);
  expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
  const published = await approve(candidate.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
});

async function designateSupplemental() {
  for (const area of ["card_facts", "printing_details"]) {
    const result = await post("/v1/source-authorities", {
      game: "one-piece",
      locale: "en",
      release_region: "OCEANIA",
      area,
      source_lineage: "limitless-one-piece-en",
      expected_generation: "0",
      rationale: "Synthetic admission test",
      idempotency_key: `admission-${area}`,
    });
    expect(result.response.status).toBe(200);
  }
}
const supplemental = { game: "one-piece", lineage: "limitless-one-piece-en", adapter: "fixture-one-piece-tabular@1" };
test("permitted supplemental authority automatically admits through a retained proposal", async () => {
  await designateSupplemental();
  const candidate = await reconcile(
    (await collect("/reconciliation/canonical-tabular", "auto-admit", supplemental)).id,
  );
  expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
  const proposals = await get("/v1/entity-proposals?game=one-piece");
  expect(proposals.response.status).toBe(200);
  expect(proposals.document.proposals).toEqual([
    expect.objectContaining({ status: "admitted", source_lineage: "limitless-one-piece-en" }),
  ]);
});

test("automation retains explicit owner rejection when later evidence satisfies automatic rules", async () => {
  await approve(
    (await reconcile((await collect("/reconciliation/card-without-printing", "unrelated-established-card")).id))
      .document,
  );
  await designateSupplemental();
  const unresolved = await reconcile(
    (await collect("/reconciliation/canonical-tabular-unresolved", "auto-unresolved", supplemental)).id,
  );
  expect(unresolved.response.status, JSON.stringify(unresolved.document)).toBe(200);
  expect(unresolved.document.cards).toEqual([]);
  expect(unresolved.document.warnings).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "entity_proposal_excluded" })]),
  );
  await approve(unresolved.document);
  const list = await get("/v1/entity-proposals?game=one-piece");
  const proposal = (list.document.proposals as { id: string }[])[0]!;
  const rejected = await post(`/v1/entity-proposals/${proposal.id}/decisions`, {
    action: "reject",
    expected_generation: "0",
    rationale: "Owner finds uncertain identity",
    idempotency_key: "explicit-source-reject",
  });
  expect(rejected.response.status).toBe(200);
  const replay = await reconcile(
    (await collect("/reconciliation/canonical-tabular", "later-qualified-evidence", supplemental)).id,
  );
  expect(replay.response.status, JSON.stringify(replay.document)).toBe(200);
  expect(replay.document.cards).toEqual([]);
  const inspected = await get(`/v1/entity-proposals/${proposal.id}`);
  expect(inspected.document).toMatchObject({ status: "rejected", generation: 1 });
  expect(inspected.document.history).toHaveLength(1);
  await approve(replay.document);
  expect(
    (
      await post(`/v1/entity-proposals/${proposal.id}/decisions`, {
        action: "reconsider",
        expected_generation: "1",
        rationale: "Owner explicitly requests reassessment",
        idempotency_key: "source-reconsider",
      })
    ).response.status,
  ).toBe(200);
  const reconsidered = await reconcile(
    (await collect("/reconciliation/canonical-tabular", "owner-reconsidered", supplemental)).id,
  );
  expect(reconsidered.response.status, JSON.stringify(reconsidered.document)).toBe(200);
  expect(reconsidered.document.printings).toHaveLength(1);
  expect((await get(`/v1/entity-proposals/${proposal.id}`)).document.history).toHaveLength(3);
});

test.each(["canonical-tabular", "canonical-tabular-missing-number"])(
  "later publisher confirmation keeps supplemental IDs and authority: %s",
  async (scenario) => {
    await designateSupplemental();
    const initial = await reconcile(
      (await collect(`/reconciliation/${scenario}`, "supplemental-first", supplemental)).id,
    );
    expect(initial.response.status).toBe(200);
    if (scenario.endsWith("missing-number")) {
      expect(initial.document.cards).toEqual([
        expect.objectContaining({ official_identity: { kind: "unknown", value: null } }),
      ]);
    }
    await approve(initial.document);
    const started = await postFixtureEvidence({
      plans: [
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "fixture-one-piece-json@3",
          requests: [{ id: "official", url: "https://official-source.invalid/reconciliation/canonical-official" }],
        },
        {
          supported_game: "one-piece",
          source_lineage: "limitless-one-piece-en",
          adapter_version: "fixture-one-piece-tabular@1",
          requests: [{ id: "supplemental", url: `https://official-source.invalid/reconciliation/${scenario}` }],
        },
      ],
      idempotency_key: "publisher-confirmation",
    });
    expect(started.response.status, JSON.stringify(started.document)).toBe(201);
    await collectFixtureEvidence(
      testEnv.CATALOGUE_DB,
      testEnv.EVIDENCE_OBJECTS,
      testEnv.OFFICIAL_SOURCE_TRANSPORT,
      String(started.document.id),
    );
    const confirmed = await reconcile(String(started.document.id));
    expect(confirmed.response.status, JSON.stringify(confirmed.document)).toBe(200);
    expect(confirmed.document.cards).toEqual([
      expect.objectContaining({
        id: (initial.document.cards as { id: string }[])[0]!.id,
        official_identity: { kind: "card_number", value: "OP96-001" },
      }),
    ]);
    const beforePrinting = (initial.document.printings as { id: string }[])[0]!;
    expect(confirmed.document.printings).toEqual([expect.objectContaining({ id: beforePrinting.id })]);
    const mapping = await get(`/v1/reconciliation/identities/${beforePrinting.id}`);
    expect(mapping.document.mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_lineage: "one-piece-en",
          evidence: expect.objectContaining({
            publisher_confirmation: expect.objectContaining({ fields: expect.arrayContaining(["printed_rules_text"]) }),
          }),
        }),
      ]),
    );
    const authorities = await get("/v1/source-authorities");
    expect(authorities.document.authorities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ area: "card_facts", source_lineage: "limitless-one-piece-en" }),
      ]),
    );
  },
);

test("owner cannot allocate a second numbered Card and can link evidence without changing accepted facts", async () => {
  const initial = await reconcile((await collect("/reconciliation/card-without-printing", "link-target")).id);
  await approve(initial.document);
  const card = (initial.document.cards as { id: string; [key: string]: unknown }[])[0]!;
  const { id, ...content } = card;
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "link-evidence",
    content: { card: content },
    evidence: { attestation: "Synthetic personal inspection confirms this existing Card." },
    idempotency_key: "link-proposal",
  });
  const duplicate = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Incorrectly create duplicate",
    idempotency_key: "duplicate-admit",
  });
  expect(duplicate.response.status).toBe(422);
  const linked = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "link",
    card_id: id,
    expected_generation: "0",
    rationale: "Attach evidence to established identity",
    idempotency_key: "link-existing",
  });
  expect(linked.response.status, JSON.stringify(linked.document)).toBe(200);
  const history = linked.document.history as { decision: { card: { id: string }; linked: boolean } }[];
  expect(history[0]!.decision).toMatchObject({ card: { id }, linked: true });
});

test("owner appends corrected intake on reconsideration while retaining the original incomplete proposal", async () => {
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "incomplete-then-complete",
    content: { card: { name: "Incomplete" } },
    evidence: {},
    idempotency_key: "incomplete-create",
  });
  const amended = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "reconsider",
    expected_generation: "0",
    rationale: "New personal inspection supplies required structure",
    content: { card: syntheticCard },
    evidence: { attestation: "Synthetic new personal inspection" },
    idempotency_key: "complete-intake",
  });
  expect(amended.response.status, JSON.stringify(amended.document)).toBe(200);
  expect(amended.document.content).toMatchObject({ card: { name: "Synthetic owner card" } });
  expect(amended.document.initial_intake).toMatchObject({ content: { card: { name: "Incomplete" } } });
  const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "1",
    rationale: "Required evidence now established",
    idempotency_key: "complete-admit",
  });
  expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
  expect(admitted.document.history).toHaveLength(2);
});

test("owner reaffirms admission without ID churn and unrelated Printing metadata does not invalidate the attestation", async () => {
  await designateSupplemental();
  const initial = await reconcile(
    (await collect("/reconciliation/canonical-tabular", "reaffirm-initial", supplemental)).id,
  );
  await approve(initial.document);
  const proposals = await get("/v1/entity-proposals?game=one-piece");
  const id = (proposals.document.proposals as { id: string }[])[0]!.id;
  expect(
    (
      await post(`/v1/entity-proposals/${id}/decisions`, {
        action: "reconsider",
        expected_generation: "1",
        rationale: "Owner supplies personal inspection",
        evidence: { attestation: "Synthetic new personal evidence" },
        idempotency_key: "reaffirm-reconsider",
      })
    ).response.status,
  ).toBe(200);
  const reaffirmed = await post(`/v1/entity-proposals/${id}/decisions`, {
    action: "admit",
    expected_generation: "2",
    rationale: "Reaffirm the established physical identity",
    exception: { scope: ["identity"], attestation: "Synthetic personal inspection of same identity" },
    idempotency_key: "reaffirm-admit",
  });
  expect(reaffirmed.response.status, JSON.stringify(reaffirmed.document)).toBe(200);
  const printing = (initial.document.printings as { id: string }[])[0]!;
  expect((reaffirmed.document.history as { decision: unknown }[])[2]!.decision).toMatchObject({
    printing: { id: printing.id },
  });
  const updated = await reconcile(
    (await collect("/reconciliation/canonical-tabular-unrelated", "unrelated-metadata", supplemental)).id,
  );
  expect(updated.response.status, JSON.stringify(updated.document)).toBe(200);
  expect(updated.document.printings).toEqual([
    expect.objectContaining({
      id: printing.id,
      game_data: { profile: "one-piece@1", attributes: { illustration_types: ["original"] } },
    }),
  ]);
});

test("manual Printing unknown fields retain actionable raw-value warnings through candidate inspection", async () => {
  const proposal = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "unknown-printing-mechanics",
    content: {
      card: syntheticCard,
      printing: {
        rarity: { raw: null, normalized: null },
        printed_rules_text: null,
        future_finish: "unmapped finish",
        game_data: {
          profile: "one-piece@1",
          attributes: { illustration_types: [], future_mechanic: "unmapped mechanic" },
        },
      },
    },
    evidence: { attestation: "Synthetic inspected Printing" },
    idempotency_key: "unknown-printing-create",
  });
  const admitted = await post(`/v1/entity-proposals/${proposal.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Retain optional unknowns",
    exception: { scope: ["identity"], attestation: "Synthetic physical identity established" },
    idempotency_key: "unknown-printing-admit",
  });
  expect(admitted.response.status).toBe(200);
  const candidate = await reconcile(
    (await collect("/reconciliation/card-without-printing", "unknown-printing-candidate")).id,
  );
  expect(candidate.response.status).toBe(200);
  expect(candidate.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "unknown_source_field", raw_value: "unmapped finish" }),
      expect.objectContaining({ code: "unknown_source_field", raw_value: "unmapped mechanic" }),
    ]),
  );
});

test("admission reconsideration cannot reassign an established Printing to another Card", async () => {
  const accepted: { proposal: string; card: string }[] = [];
  for (const name of ["A", "B"]) {
    const created = await post("/v1/entity-proposals", {
      game: "one-piece",
      source_lineage: "owner",
      reference: `identity-${name}`,
      content: {
        card: { ...syntheticCard, name: `Synthetic ${name}` },
        ...(name === "A"
          ? {
              printing: {
                rarity: { raw: null, normalized: null },
                printed_rules_text: null,
                game_data: { profile: "one-piece@1", attributes: { illustration_types: [] } },
              },
            }
          : {}),
      },
      evidence: { attestation: `Synthetic inspection of ${name}` },
      idempotency_key: `identity-create-${name}`,
    });
    const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
      action: "admit",
      expected_generation: "0",
      rationale: "Establish distinct identity",
      exception: { scope: ["identity"], attestation: "Synthetic physical identity proof" },
      idempotency_key: `identity-admit-${name}`,
    });
    expect(admitted.response.status).toBe(200);
    accepted.push({
      proposal: String(created.document.id),
      card: (admitted.document.history as { decision: { card: { id: string } } }[])[0]!.decision.card.id,
    });
  }
  await approve(
    (await reconcile((await collect("/reconciliation/card-without-printing", "identity-publish")).id)).document,
  );
  expect(
    (
      await post(`/v1/entity-proposals/${accepted[0]!.proposal}/decisions`, {
        action: "reconsider",
        expected_generation: "1",
        rationale: "Review admission evidence",
        idempotency_key: "identity-reconsider",
      })
    ).response.status,
  ).toBe(200);
  const reassigned = await post(`/v1/entity-proposals/${accepted[0]!.proposal}/decisions`, {
    action: "admit",
    expected_generation: "2",
    card_id: accepted[1]!.card,
    rationale: "Attempt identity correction through admission",
    exception: { scope: ["identity"], attestation: "Synthetic override attempt" },
    idempotency_key: "identity-reassign",
  });
  expect(reassigned.response.status, JSON.stringify(reassigned.document)).toBe(422);
});
