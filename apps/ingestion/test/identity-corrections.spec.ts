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

test("reviewed known-number merge preserves a source Printing through corrected evidence and subsequent refresh", async () => {
  const before = await reconcile((await collect("/reconciliation/identity-correction-before", "known-before")).id);
  const card = (before.document.cards as Record<string, unknown>[])[0]!;
  const printing = (before.document.printings as { id: string }[])[0]!;
  await approve(before.document);
  const created = await post("/v1/entity-proposals", {
    game: "one-piece",
    source_lineage: "owner",
    reference: "known-corrected-card",
    content: { card: { ...card, official_identity: { kind: "card_number", value: "OP94-002" } } },
    evidence: { attestation: "Synthetic owner inspection of corrected number" },
    idempotency_key: "known-card",
  });
  const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
    action: "admit",
    expected_generation: "0",
    rationale: "Synthetic replacement Card",
    idempotency_key: "known-card-admit",
  });
  expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
  const target = (admitted.document.history as { decision: { card: { id: string } } }[])[0]!.decision.card.id;
  const published = await approve(
    (await reconcile((await collect("/reconciliation/identity-correction-before", "known-target-publish")).id))
      .document,
  );
  const proposal = {
    game: "one-piece",
    entity_kind: "card",
    action: "merge",
    source_ids: [card.id],
    replacement_ids: [target],
    printing_assignments: {},
    expected_current_revision_id: published.document.resulting_revision_id,
    rationale: "Owner establishes equivalence across known numbers",
    evidence: { attestation: "Synthetic inspection confirms the existing Printing depicts the corrected Card" },
  };
  const validation = await post("/v1/identity-corrections/validate", proposal);
  expect(validation.response.status).toBe(200);
  expect(
    (
      await post("/v1/identity-corrections", {
        ...proposal,
        review_digest: validation.document.review_digest,
        idempotency_key: "known-merge",
      })
    ).response.status,
  ).toBe(201);
  for (const key of ["known-corrected", "known-refreshed"]) {
    const corrected = await reconcile((await collect("/reconciliation/identity-correction-renumbered", key)).id);
    expect(corrected.response.status, JSON.stringify(corrected.document)).toBe(200);
    const accepted = await approve(corrected.document);
    expect(accepted.response.status, JSON.stringify(accepted.document)).toBe(200);
    const records = await exportComponentRecords(String(accepted.document.resulting_revision_id), "printings");
    expect(records).toEqual([expect.objectContaining({ id: printing.id, card_id: target })]);
  }
  const contradicted = await reconcile(
    (await collect("/reconciliation/identity-correction-renumbered-contradictory", "known-contradiction")).id,
  );
  expect(contradicted.response.status).toBe(409);
  expect(contradicted.document.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "printing_match_contradictory" })]),
  );
  const mappings = await get(`/v1/reconciliation/identities/${printing.id}`);
  expect((mappings.document.mappings as unknown[]).length).toBeGreaterThanOrEqual(3);
});

test("new Printing discovered after a Card split can receive an append-only owner assignment", async () => {
  const source = await reconcile((await collect("/reconciliation/identity-correction-before", "late-seed")).id);
  const original = (source.document.cards as { id: string }[])[0]!;
  const originalPrinting = (source.document.printings as { id: string }[])[0]!;
  await approve(source.document);
  const left = await admitSyntheticPrinting("late-left"),
    right = await admitSyntheticPrinting("late-right");
  const seeded = await approve(
    (await reconcile((await collect("/reconciliation/identity-correction-before", "late-targets")).id)).document,
  );
  const proposal = {
    game: "one-piece",
    entity_kind: "card",
    action: "split",
    source_ids: [original.id],
    replacement_ids: [left.card.id, right.card.id],
    printing_assignments: { [originalPrinting.id]: left.card.id },
    expected_current_revision_id: seeded.document.resulting_revision_id,
    rationale: "Synthetic conflated Card split",
    evidence: { attestation: "Synthetic reviewed variants" },
  };
  const validation = await post("/v1/identity-corrections/validate", proposal);
  expect(validation.response.status).toBe(200);
  const decision = await post("/v1/identity-corrections", {
    ...proposal,
    review_digest: validation.document.review_digest,
    idempotency_key: "late-split",
  });
  expect(decision.response.status).toBe(201);
  await approve(
    (await reconcile((await collect("/reconciliation/identity-correction-before", "late-split-publish")).id)).document,
  );
  const discovery = await reconcile(
    (await collect("/reconciliation/identity-correction-discovered", "late-discovered")).id,
  );
  expect(discovery.response.status, JSON.stringify(discovery.document)).toBe(200);
  const exclusion = (discovery.document.warnings as { code: string; printing_id: string }[]).find(
    (w) => w.code === "identity_correction_exclusion",
  )!;
  expect(exclusion).toBeDefined();
  const published = await approve(discovery.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const assignment = {
    ...proposal,
    action: "assign",
    replacement_ids: [right.card.id],
    printing_assignments: { [exclusion.printing_id]: right.card.id },
    expected_current_revision_id: published.document.resulting_revision_id,
    rationale: "Owner identifies the newly observed Printing as the right Card",
  };
  const reviewed = await post("/v1/identity-corrections/validate", assignment);
  expect(reviewed.response.status, JSON.stringify(reviewed.document)).toBe(200);
  const assigned = await post("/v1/identity-corrections", {
    ...assignment,
    review_digest: reviewed.document.review_digest,
    idempotency_key: "late-assign",
  });
  expect(assigned.response.status, JSON.stringify(assigned.document)).toBe(201);
  const refreshed = await reconcile(
    (await collect("/reconciliation/identity-correction-discovered", "late-assigned-refresh")).id,
  );
  expect(refreshed.response.status, JSON.stringify(refreshed.document)).toBe(200);
  const final = await approve(refreshed.document);
  expect(final.response.status, JSON.stringify(final.document)).toBe(200);
  expect(await exportComponentRecords(String(final.document.resulting_revision_id), "printings")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: exclusion.printing_id, card_id: right.card.id })]),
  );
  expect((await get(`/v1/identity-corrections/${decision.document.id}`)).document.printing_assignments).toEqual({
    [originalPrinting.id]: left.card.id,
  });
});

test.each(["lookup", "application"])(
  "a retained correction %s storage outage pauses and resumes the same reviewed Card association",
  async (phase) => {
    const { testEnv, requiredString } = await import("./reconciliation-helpers");
    const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
    const original = await admitSyntheticPrinting("lookup-source");
    const replacement = await admitSyntheticPrinting("lookup-replacement");
    const seed = await approve(
      (await reconcile((await collect("/reconciliation/card-without-printing", "lookup-seed")).id)).document,
    );
    expect(seed.response.status).toBe(200);
    const proposal = {
      game: "one-piece",
      entity_kind: "card",
      action: "merge",
      source_ids: [original.card.id],
      replacement_ids: [replacement.card.id],
      printing_assignments: {},
      expected_current_revision_id: seed.document.resulting_revision_id,
      rationale: "Synthetic reviewed Card association",
      evidence: { attestation: "Synthetic owner review" },
    };
    const validation = await post("/v1/identity-corrections/validate", proposal);
    expect(validation.response.status, JSON.stringify(validation.document)).toBe(200);
    expect(
      (
        await post("/v1/identity-corrections", {
          ...proposal,
          review_digest: validation.document.review_digest,
          idempotency_key: "lookup-merge",
        })
      ).response.status,
    ).toBe(201);
    const run = await collect("/reconciliation/card-without-printing", "lookup-next");
    const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
    let unavailable = true;
    let failures = 0;
    const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      statements.set(proxy, { sql, values });
      return proxy;
    };
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch")
          return (batch: D1PreparedStatement[]) => {
            if (
              unavailable &&
              batch.some((statement) => {
                const entry = statements.get(statement);
                if (!entry?.sql.includes("INSERT INTO reconciliation_reducer_state")) return false;
                if (phase === "lookup") return entry.values.includes("correction_merges");
                if (!entry.values.includes("candidate_corrections_printings")) return false;
                const record = JSON.parse(String(entry.values[4])) as {
                  value: { entity: { id?: string; card_id?: string } | null };
                };
                return (
                  record.value.entity?.id === original.printing.id &&
                  record.value.entity.card_id === replacement.card.id
                );
              })
            ) {
              failures++;
              throw new Error("Injected correction lookup storage outage");
            }
            return target.batch(batch);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const payload = {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "lookup-next",
      observed_at: new Date().toISOString(),
      generation: 0,
    };
    const event = { payload } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await callback();
          } catch (error) {
            if (attempt === 3) throw error;
          }
        }
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
      state: "paused",
      generation: 1,
    });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-lookup",
        })
      ).response.status,
    ).toBe(200);
    unavailable = false;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...payload, generation: 1 } } as typeof event,
      step,
    );
    const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
    expect(status.document.state).toBe("sealed");
    const published = await post(`/v1/ingestion-runs/${run.id}/approval`, {
      candidate_digest: status.document.candidate_digest,
      expected_current_revision_id: payload.expected_current_revision_id,
      idempotency_key: "publish-resumed-lookup",
    });
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    const printings = await exportComponentRecords(String(published.document.resulting_revision_id), "printings");
    expect(printings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: original.printing.id, card_id: replacement.card.id })]),
    );
  },
);
