import { expect, test } from "vitest";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { catalogueStore } from "../../../src/catalogue/shared";
import worker from "../src/index";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { retainLegacyCorrectionPin } from "./query-helpers/legacy-decision-pins";
import {
  collect,
  exportComponentRecords,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

async function prepareIdentityFixture(path: string, key: string, predecessor: string) {
  const source = await collect(path, key);
  const candidate = await prepareNativeCandidate(source.id, "one-piece", predecessor, `${key}-native-candidate`);
  return { candidate, records: await nativeCandidateRecords(String(candidate.id)) };
}

async function publishIdentityFixture(path: string, key: string, predecessor: string) {
  const { candidate } = await prepareIdentityFixture(path, key, predecessor);
  return approveNativeCandidate(candidate, `${key}-native-publication`);
}

/** Capture the native dispatch so the existing fault driver exclusively runs each durable unit. */
async function retainedIdentityPreparation(runId: string, predecessor: string, key: string) {
  let params: ReconciliationWorkflowParams | undefined;
  const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return queued;
    },
    get: async () => queued,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: binding },
    );
  const created = await request("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: predecessor,
    idempotency_key: key,
  });
  expect(created.status).toBe(201);
  const header = await created.json<Record<string, unknown>>();
  expect(params).toBeDefined();
  expect(params?.preparation_id).toBe(header.id);
  return {
    candidateId: String(header.id),
    params: params!,
    resume: (generation: number, idempotencyKey: string) =>
      request(`/v1/game-candidates/${header.id}/resume`, { generation, idempotency_key: idempotencyKey }),
  };
}

// Synthetic owner attestations exercise decisions; they are not real-source findings.
test("reviewed Card merge retains its decision and changes only a newly approved revision", async () => {
  const publication = await publishIdentityFixture(
    "/reconciliation/card-without-printing",
    "correction-seed",
    "catrev_spine_000",
  );
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
  const published = await publishIdentityFixture(
    "/reconciliation/card-without-printing",
    "duplicate-publish",
    revision,
  );
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
  const accepted = await publishIdentityFixture("/reconciliation/card-without-printing", "merge-publish", expected);
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

test("an empty legacy correction snapshot excludes decisions recorded before its upgraded resume", async () => {
  const original = await admitSyntheticPrinting("legacy-original");
  const left = await admitSyntheticPrinting("legacy-left");
  const right = await admitSyntheticPrinting("legacy-right");
  const seed = await publishIdentityFixture(
    "/reconciliation/card-without-printing",
    "legacy-correction-seed",
    "catrev_spine_000",
  );
  expect(seed.response.status).toBe(200);
  const proposal = {
    game: "one-piece",
    entity_kind: "printing",
    action: "split",
    source_ids: [original.printing.id],
    replacement_ids: [left.printing.id, right.printing.id],
    printing_assignments: {},
    expected_current_revision_id: String(seed.document.resulting_revision_id),
    rationale: "Synthetic decision after the retained empty snapshot",
    evidence: { attestation: "Synthetic inspection of distinct issued variants" },
  };
  const reviewed = await post("/v1/identity-corrections/validate", proposal);
  expect(reviewed.response.status).toBe(200);
  const decided = await post("/v1/identity-corrections", {
    ...proposal,
    review_digest: reviewed.document.review_digest,
    idempotency_key: "legacy-later-split",
  });
  expect(decided.response.status).toBe(201);
  const run = await collect("/reconciliation/card-without-printing", "legacy-correction-resume");
  // Simulate the retained schema-19 snapshot, whose zero cutoff is an exact empty set.
  await retainLegacyCorrectionPin(testEnv.CATALOGUE_DB).bind(run.id).run();
  const result = await reconcile(run.id);
  expect(result.response.status, JSON.stringify(result.document)).toBe(200);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const candidate = (status.document.candidates as { id: string }[])[0]!;
  const page = await get(`/v1/game-candidates/${candidate.id}/partitions`);
  expect(page.response.status).toBe(200);
  const partitions = page.document.partitions as { kind: string; ordinal: number }[];
  expect(partitions.filter(({ kind }) => kind === "identity_corrections")).toEqual([]);
  const printings: unknown[] = [];
  for (const partition of partitions.filter(({ kind }) => kind === "printings")) {
    const detail = await get(`/v1/game-candidates/${candidate.id}/partitions/${partition.ordinal}`);
    expect(detail.response.status).toBe(200);
    printings.push(...(detail.document.records as unknown[]));
  }
  expect(printings).toEqual(expect.arrayContaining([expect.objectContaining({ id: original.printing.id })]));
});

test("Printing split publishes all replacements and never chooses a consumer-owned variant", async () => {
  const original = await admitSyntheticPrinting("synthetic-conflated");
  const left = await admitSyntheticPrinting("synthetic-left");
  const right = await admitSyntheticPrinting("synthetic-right");
  const seed = await publishIdentityFixture("/reconciliation/card-without-printing", "split-seed", "catrev_spine_000");
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
  const published = await publishIdentityFixture("/reconciliation/card-without-printing", "split-next", revision);
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
  const published = await publishIdentityFixture(
    "/reconciliation/card-without-printing",
    "card-split-seed",
    "catrev_spine_000",
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
  const corrected = await publishIdentityFixture(
    "/reconciliation/card-without-printing",
    "card-split-publish",
    String(published.document.resulting_revision_id),
  );
  expect(corrected.response.status, JSON.stringify(corrected.document)).toBe(200);
  const printings = await exportComponentRecords(String(corrected.document.resulting_revision_id), "printings");
  expect(printings).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: original.printing.id, card_id: left.card.id })]),
  );
  expect(printings.some((p) => p.card_id === original.card.id)).toBe(false);
});

test("reviewed known-number merge preserves a source Printing through corrected evidence and subsequent refresh", async () => {
  const before = await prepareIdentityFixture(
    "/reconciliation/identity-correction-before",
    "known-before",
    "catrev_spine_000",
  );
  const card = (before.records.cards as Record<string, unknown>[])[0]!;
  const printing = (before.records.printings as { id: string }[])[0]!;
  const beforePublished = await approveNativeCandidate(before.candidate, "known-before-native-publication");
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
  const published = await publishIdentityFixture(
    "/reconciliation/identity-correction-before",
    "known-target-publish",
    String(beforePublished.document.resulting_revision_id),
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
  let knownPredecessor = String(published.document.resulting_revision_id);
  for (const key of ["known-corrected", "known-refreshed"]) {
    const accepted = await publishIdentityFixture(
      "/reconciliation/identity-correction-renumbered",
      key,
      knownPredecessor,
    );
    knownPredecessor = String(accepted.document.resulting_revision_id);
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
  const source = await prepareIdentityFixture(
    "/reconciliation/identity-correction-before",
    "late-seed",
    "catrev_spine_000",
  );
  const original = (source.records.cards as { id: string }[])[0]!;
  const originalPrinting = (source.records.printings as { id: string }[])[0]!;
  const sourcePublished = await approveNativeCandidate(source.candidate, "late-seed-native-publication");
  const left = await admitSyntheticPrinting("late-left"),
    right = await admitSyntheticPrinting("late-right");
  const seeded = await publishIdentityFixture(
    "/reconciliation/identity-correction-before",
    "late-targets",
    String(sourcePublished.document.resulting_revision_id),
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
  const splitPublished = await publishIdentityFixture(
    "/reconciliation/identity-correction-before",
    "late-split-publish",
    String(seeded.document.resulting_revision_id),
  );
  const discovery = await prepareIdentityFixture(
    "/reconciliation/identity-correction-discovered",
    "late-discovered",
    String(splitPublished.document.resulting_revision_id),
  );
  const exclusion = (
    [...(discovery.records.warnings ?? []), ...(discovery.records.shared_warnings ?? [])] as {
      code: string;
      printing_id: string;
    }[]
  ).find((w) => w.code === "identity_correction_exclusion")!;
  expect(exclusion).toBeDefined();
  const published = await approveNativeCandidate(discovery.candidate, "late-discovered-native-publication");
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
  const final = await publishIdentityFixture(
    "/reconciliation/identity-correction-discovered",
    "late-assigned-refresh",
    String(published.document.resulting_revision_id),
  );
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
    const { testEnv } = await import("./reconciliation-helpers");
    const { runReconciliationWorkflow } = await import("./reconciliation-workflow-driver");
    const original = await admitSyntheticPrinting("lookup-source");
    const replacement = await admitSyntheticPrinting("lookup-replacement");
    const seed = await publishIdentityFixture(
      "/reconciliation/product-typed-relationships",
      "lookup-seed",
      "catrev_spine_000",
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
    const run = await collect("/reconciliation/product-typed-relationships", "lookup-next");
    const preparation = await retainedIdentityPreparation(
      run.id,
      String(seed.document.resulting_revision_id),
      "lookup-next",
    );
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
    const payload = preparation.params;
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
    expect((await get(`/v1/game-candidates/${preparation.candidateId}`)).document).toMatchObject({
      state: "paused",
      generation: 1,
    });
    expect((await preparation.resume(1, "resume-lookup")).status).toBe(200);
    unavailable = false;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...payload, generation: 1 } } as typeof event,
      step,
    );
    const status = await get(`/v1/game-candidates/${preparation.candidateId}`);
    expect(status.document.state).toBe("sealed");
    const published = await approveNativeCandidate(status.document, "publish-resumed-lookup");
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    const printings = await exportComponentRecords(String(published.document.resulting_revision_id), "printings");
    for (const component of ["products", "distribution-contexts", "relationships"] as const) {
      const before = await exportComponentRecords(String(seed.document.resulting_revision_id), component);
      const after = await exportComponentRecords(String(published.document.resulting_revision_id), component);
      expect(before.length).toBeGreaterThan(0);
      expect(after.map(({ id }) => id).sort()).toEqual(before.map(({ id }) => id).sort());
    }

    expect(printings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: original.printing.id, card_id: replacement.card.id })]),
    );
  },
);

test.each(["associations", "application", "lookup"])(
  "reviewed identity %s prepare through durable bounded groups",
  async (failurePhase) => {
    const published = await publishIdentityFixture(
      "/reconciliation/curated-conflict-fanout-base",
      "association-seed",
      "catrev_spine_000",
    );
    expect(published.response.status).toBe(200);
    const cards = await exportComponentRecords(String(published.document.resulting_revision_id), "cards");
    for (let index = 0; index < 12; index++) {
      const proposal = {
        game: "one-piece",
        entity_kind: "card",
        action: "merge",
        source_ids:
          index === 0
            ? cards.slice(0, 9).map((card) => card.id)
            : [cards[failurePhase !== "associations" ? 8 + index : 8 + index * 2]!.id],
        replacement_ids: [cards[index === 0 ? 9 : failurePhase !== "associations" ? 9 + index : 9 + index * 2]!.id],
        printing_assignments: {},
        expected_current_revision_id: published.document.resulting_revision_id,
        rationale: "Synthetic owner comparison establishes one rules-level Card",
        evidence: { attestation: "Synthetic comparison of retained identities" },
      };
      const validated = await post("/v1/identity-corrections/validate", proposal);
      expect(validated.response.status, JSON.stringify(validated.document)).toBe(200);
      const decision = await post("/v1/identity-corrections", {
        ...proposal,
        review_digest: validated.document.review_digest,
        idempotency_key: `association-merge-${index}`,
      });
      expect(decision.response.status).toBe(201);
    }
    const run = await collect(
      failurePhase === "application"
        ? "/reconciliation/identity-chain-card-surface"
        : "/reconciliation/curated-conflict-fanout-base",
      "association-refresh",
    );
    const preparation = await retainedIdentityPreparation(
      run.id,
      String(published.document.resulting_revision_id),
      `reconcile-${run.id}`,
    );
    let calls = 0;
    const associationCalls: number[] = [];
    const applicationCalls: number[] = [];
    const lookupCalls: number[] = [];
    const reductionCalls: number[] = [];
    const associationOffsets: number[] = [];
    let sawChain = false;
    let armed = false,
      resumed = false,
      writes = 0,
      failures = 0;
    const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
    const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => {
              if (
                failurePhase === "lookup" &&
                armed &&
                !resumed &&
                sql.includes("INSERT INTO reconciliation_checkpoints") &&
                values[1] === "identity_lookup"
              ) {
                failures++;
                throw new Error("Injected identity lookup checkpoint outage.");
              }
              return wrap(target.bind(...values), sql, values);
            };
          const value = Reflect.get(target, property);
          if (["run", "first", "all", "raw"].includes(String(property)))
            return (...args: unknown[]) => {
              calls++;
              return Reflect.apply(value, target, args);
            };
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
          return (...args: Parameters<D1Database["batch"]>) => {
            calls++;
            if (
              failurePhase !== "lookup" &&
              armed &&
              !resumed &&
              args[0].some((statement) => {
                const entry = statements.get(statement);
                return (
                  entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                  entry.values.includes(
                    failurePhase === "associations"
                      ? "correction_merges"
                      : "candidate_corrections_identity_corrections",
                  )
                );
              }) &&
              ++writes === 2
            ) {
              failures++;
              throw new Error("Injected identity association storage outage after a partial write.");
            }
            return target.batch(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const event = {
      payload: preparation.params,
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const step = {
      do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          calls = 0;
          writes = 0;
          try {
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (JSON.parse(result).continuation?.phase === "official_reduction") reductionCalls.push(calls);
        if (JSON.parse(result).continuation?.phase === "identity_lookup") {
          lookupCalls.push(calls);
          if (failurePhase === "lookup" && !armed) {
            const cursor = (await reconciliationCheckpoint<{ visited: string[] }>(
              catalogueStore(testEnv.CATALOGUE_DB),
              preparation.candidateId,
              "identity_lookup",
            ))!.value;
            if (cursor.visited.length > 0) {
              armed = true;
              sawChain = true;
            }
          }
        }
        if (JSON.parse(result).continuation?.phase === "identity_application") {
          applicationCalls.push(calls);
          if (failurePhase === "application" && (!armed || !sawChain)) {
            const checkpoint = (await reconciliationCheckpoint<{
              stage: string;
              source: number;
              chain: { visited: string[] } | null;
            }>(catalogueStore(testEnv.CATALOGUE_DB), preparation.candidateId, "identity_application"))!.value;
            sawChain ||= (checkpoint.chain?.visited.length ?? 0) > 0;
            if (checkpoint.stage === "retire" && checkpoint.source > 0) armed = true;
          }
        }
        if (JSON.parse(result).continuation?.phase === "identity_associations") {
          associationCalls.push(calls);
          const checkpoint = (await reconciliationCheckpoint<{ association: number }>(
            catalogueStore(testEnv.CATALOGUE_DB),
            preparation.candidateId,
            "identity_associations",
          ))!.value;
          associationOffsets.push(checkpoint.association);
          if (failurePhase === "associations" && checkpoint.association > 0) armed = true;
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    const environment = { ...testEnv, CATALOGUE_DB: database };
    await runReconciliationWorkflow(environment, event, step);
    const paused = (await get(`/v1/game-candidates/${preparation.candidateId}`)).document;
    expect(failures, JSON.stringify({ state: paused.state, failure_code: paused.failure_code })).toBe(4);
    expect(paused).toMatchObject({ state: "paused", generation: 1 });
    expect((await preparation.resume(1, "resume-identity-associations")).status).toBe(200);
    resumed = true;
    await runReconciliationWorkflow(
      environment,
      { payload: { ...event.payload, generation: 1 } } as typeof event,
      step,
    );
    expect((await get(`/v1/game-candidates/${preparation.candidateId}`)).document.deadline).toBe(paused.deadline);
    if (failurePhase !== "associations") expect(sawChain).toBe(true);
    if (failurePhase === "lookup") {
      expect(lookupCalls.length).toBeGreaterThan(0);
      expect(Math.max(...lookupCalls)).toBeLessThanOrEqual(100);
      expect(Math.max(...reductionCalls)).toBeLessThanOrEqual(100);
    }
    expect(applicationCalls.length).toBeGreaterThan(0);
    expect(Math.max(...applicationCalls)).toBeLessThanOrEqual(100);
    expect(associationOffsets.some((offset) => offset > 0)).toBe(true);
    expect(associationCalls.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...associationCalls)).toBeLessThanOrEqual(100);
    const candidate = await get(`/v1/game-candidates/${preparation.candidateId}`);
    expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
    const checkpoint = await reconciliationCheckpoint(
      catalogueStore(testEnv.CATALOGUE_DB),
      preparation.candidateId,
      "identity_associations",
    );
    expect(checkpoint).toMatchObject({ value: { complete: true, processedDecisions: 12 } });
    expect(checkpoint!.ordinal).toBeGreaterThan(0);
    const accepted = await approveNativeCandidate(candidate.document, "association-reviewed-publication");
    expect(accepted.response.status, JSON.stringify(accepted.document)).toBe(200);
    const current = String(accepted.document.resulting_revision_id);
    expect(await exportComponentRecords(current, "cards")).toHaveLength(12);
    const finalPrintings = await exportComponentRecords(current, "printings");
    expect(finalPrintings).toHaveLength(32);
    if (failurePhase !== "associations")
      expect(finalPrintings.filter((printing) => printing.card_id === cards[20]!.id)).toHaveLength(21);
    expect(await exportComponentRecords(current, "identity-corrections")).toHaveLength(20);
  },
);
