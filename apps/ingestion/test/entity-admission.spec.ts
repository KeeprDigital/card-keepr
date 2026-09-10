import { expect, test } from "vitest";
import {
  insertAdmissionDecisionStatement,
  proposalHistoryStatement,
} from "../../../src/catalogue/reconciliation/entity-admission-repository";
import { assessSourceAdmission } from "../../../src/catalogue/reconciliation/entity-admission-source";
import { reconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { parseReconciliationObservation } from "../../../src/catalogue/reconciliation/reconciliation-observation";
import { initializeReconciliationProgress } from "../../../src/catalogue/reconciliation/reconciliation-progress";
import { catalogueStore } from "../../../src/catalogue/shared";
import { reconciliationSourceDocument } from "../../../test/support/fake-publisher/reconciliation-documents";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { recoverHistoricalPublication } from "./historical-publication-fixture";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { retainNativePreparation } from "./native-preparation-fixture";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import { retainLegacyAdmissionPin, retainLegacyAdmissionSelection } from "./query-helpers/legacy-decision-pins";
import {
  collect,
  exportComponentRecords,
  get,
  installReconciliationSuite,
  post,
  postFixtureEvidence,
  reconcile,
  testEnv,
} from "./reconciliation-helpers";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

async function prepareAdmissionSource(
  path: string,
  key: string,
  predecessor: string,
  source?: Parameters<typeof collect>[2],
) {
  const run = await collect(path, key, source);
  const candidate = await prepareNativeCandidate(run.id, "one-piece", predecessor, `${key}-candidate`);
  return { candidate, records: await nativeCandidateRecords(String(candidate.id)) };
}

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

test.each([false, true])(
  "a legacy admission snapshot retains its selection after upgrade (selected: %s)",
  async (selected) => {
    const created = await post("/v1/entity-proposals", {
      game: "one-piece",
      source_lineage: "owner",
      reference: "legacy-pinned-owner-card",
      content: { card: syntheticCard },
      evidence: { attestation: "Synthetic historical owner intake." },
      idempotency_key: "legacy-pinned-proposal",
    });
    expect(created.response.status).toBe(201);
    const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
      action: "admit",
      expected_generation: "0",
      rationale: "Decision made after the historical snapshot",
      idempotency_key: "legacy-later-admit",
    });
    expect(admitted.response.status).toBe(200);
    const run = await collect("/reconciliation/card-without-printing", "legacy-admission-resume");
    // Retain the schema-18 snapshot: either empty or this proposal before admission.
    const policy = await get("/v1/source-authorities");
    expect(policy.response.status).toBe(200);
    await testEnv.CATALOGUE_DB.batch([
      retainLegacyAdmissionPin(testEnv.CATALOGUE_DB).bind(run.id, JSON.stringify(policy.document)),
      ...(selected ? [retainLegacyAdmissionSelection(testEnv.CATALOGUE_DB).bind(run.id, created.document.id)] : []),
    ]);
    const result = await reconcile(run.id);
    expect(result.response.status, JSON.stringify(result.document)).toBe(200);
    const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
    expect(status.document.admission_decision_count).toBe(selected ? 1 : 0);
    const published = await recoverHistoricalPublication(run.id, "legacy-admission-publication");
    expect(published.response.status).toBe(200);
    const cards = await exportComponentRecords(String(published.document.resulting_revision_id), "cards");
    expect(cards).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "Synthetic owner card" })]));
  },
);

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
  const candidate = await prepareNativeCandidate(
    run.id,
    "one-piece",
    "catrev_spine_000",
    "admission-publish-candidate",
  );
  const records = await nativeCandidateRecords(String(candidate.id));
  expect([...(records.warnings ?? []), ...(records.shared_warnings ?? [])]).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "entity_admission" })]),
  );
  const published = await approveNativeCandidate(candidate, "admission-publish-publication");
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

test.each([
  { count: 32, warningCount: 0 },
  { count: 1, warningCount: 64 },
])(
  "owner admissions enter bounded preparation groups ($count decisions, $warningCount warnings)",
  async ({ count, warningCount }) => {
    for (let index = 0; index < count; index++) {
      const created = await post("/v1/entity-proposals", {
        game: "one-piece",
        source_lineage: "owner",
        reference: `bounded-admission-${index}`,
        content: {
          card: {
            ...syntheticCard,
            name: `Synthetic admitted Card ${index}`,
            game_data: {
              ...syntheticCard.game_data,
              attributes: {
                ...syntheticCard.game_data.attributes,
                ...Object.fromEntries(
                  Array.from({ length: warningCount }, (_, index) => [`unknown_${index}`, "Synthetic warning value"]),
                ),
              },
            },
          },
        },
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
    const preparation = await retainNativePreparation(run.id, "catrev_spine_000", "bounded-admission-native");
    let calls = 0;
    let armed = false,
      resumed = false,
      failures = 0;
    const admissionCalls: number[] = [];
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...values: unknown[]) => {
              if (
                armed &&
                !resumed &&
                sql.includes("INSERT INTO reconciliation_checkpoints") &&
                values[1] === "entity_admissions"
              ) {
                failures++;
                throw new Error("Injected admission warning checkpoint outage.");
              }
              return wrap(target.bind(...values), sql);
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
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch")
          return (...args: Parameters<D1Database["batch"]>) => {
            calls++;
            return target.batch(...args);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const event = { payload: preparation.params } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const step = {
      do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        let result: string;
        for (let attempt = 0; ; attempt++) {
          calls = 0;
          try {
            result = await callback();
            break;
          } catch (error) {
            if (attempt >= config.retries.limit) throw error;
          }
        }
        if (JSON.parse(result).continuation?.phase === "entity_admissions") {
          admissionCalls.push(calls);
          if (warningCount && !armed) {
            const checkpoint = await reconciliationCheckpoint<{ pendingWarning: number | null }>(
              catalogueStore(testEnv.CATALOGUE_DB),
              preparation.candidateId,
              "entity_admissions",
            );
            const cursor = checkpoint!.value;
            if (cursor.pendingWarning !== null && cursor.pendingWarning > 0) armed = true;
          }
        }
        return result;
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    if (warningCount) {
      expect(failures).toBe(4);
      const paused = (await get(`/v1/game-candidates/${preparation.candidateId}`)).document;
      expect(paused).toMatchObject({ state: "paused", generation: 1 });
      expect((await preparation.resume(1, "resume-admission-warnings")).status).toBe(200);
      resumed = true;
      await runReconciliationWorkflow(
        { ...testEnv, CATALOGUE_DB: database },
        { payload: { ...event.payload, generation: 1 } } as typeof event,
        step,
      );
      expect((await get(`/v1/game-candidates/${preparation.candidateId}`)).document).toMatchObject({
        state: "sealed",
        deadline: paused.deadline,
      });
    }
    expect(admissionCalls.length).toBeGreaterThanOrEqual(Math.max(Math.ceil(count / 4), Math.ceil(warningCount / 4)));
    expect(Math.max(...admissionCalls)).toBeLessThanOrEqual(100);
    const candidate = await get(`/v1/game-candidates/${preparation.candidateId}`);
    expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
    const records = await nativeCandidateRecords(preparation.candidateId);
    expect(records.cards).toHaveLength(count + 1);
    const checkpoint = await reconciliationCheckpoint(
      catalogueStore(testEnv.CATALOGUE_DB),
      preparation.candidateId,
      "entity_admissions",
    );
    expect(checkpoint).toMatchObject({
      value: { complete: true, processedDecisions: count, cards: count, pendingWarning: null },
    });
    expect(checkpoint!.ordinal).toBeGreaterThanOrEqual(Math.max(Math.ceil(count / 4), Math.ceil(warningCount / 4)) - 1);
    if (warningCount) {
      const warnings = (records.warnings ?? []).length + (records.shared_warnings ?? []).length;
      expect(warnings).toBeGreaterThanOrEqual(warningCount + 1);
    }
    const published = await approveNativeCandidate(candidate.document, "bounded-admission-publication");
    expect(published.response.status).toBe(200);
    const cards = await exportComponentRecords(String(published.document.resulting_revision_id), "cards");
    expect(cards).toHaveLength(count + 1);
    expect(cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Synthetic admitted Card 0" }),
        expect.objectContaining({ name: `Synthetic admitted Card ${count - 1}` }),
      ]),
    );
  },
);

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
  const run = await collect("/reconciliation/card-without-printing", "printing-publish");
  const candidate = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "printing-publish-candidate");
  const published = await approveNativeCandidate(candidate, "printing-publish-publication");
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
  await prepareAdmissionSource("/reconciliation/canonical-tabular", "auto-admit", "catrev_spine_000", supplemental);
  const proposals = await get("/v1/entity-proposals?game=one-piece");
  expect(proposals.response.status).toBe(200);
  expect(proposals.document.proposals).toEqual([
    expect.objectContaining({ status: "admitted", source_lineage: "limitless-one-piece-en" }),
  ]);
});

test("automation retains explicit owner rejection when later evidence satisfies automatic rules", async () => {
  const established = await prepareAdmissionSource(
    "/reconciliation/card-without-printing",
    "unrelated-established-card",
    "catrev_spine_000",
  );
  const establishedPublication = await approveNativeCandidate(
    established.candidate,
    "unrelated-established-publication",
  );
  await designateSupplemental();
  const unresolved = await prepareAdmissionSource(
    "/reconciliation/canonical-tabular-unresolved",
    "auto-unresolved",
    String(establishedPublication.document.resulting_revision_id),
    supplemental,
  );
  expect(unresolved.records.cards!.map(({ id }) => id)).toEqual(established.records.cards!.map(({ id }) => id));
  expect([...(unresolved.records.warnings ?? []), ...(unresolved.records.shared_warnings ?? [])]).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "entity_proposal_excluded" })]),
  );
  const unresolvedPublication = await approveNativeCandidate(unresolved.candidate, "unresolved-publication");
  const list = await get("/v1/entity-proposals?game=one-piece");
  const proposal = (list.document.proposals as { id: string }[])[0]!;
  const rejected = await post(`/v1/entity-proposals/${proposal.id}/decisions`, {
    action: "reject",
    expected_generation: "0",
    rationale: "Owner finds uncertain identity",
    idempotency_key: "explicit-source-reject",
  });
  expect(rejected.response.status).toBe(200);
  const replay = await prepareAdmissionSource(
    "/reconciliation/canonical-tabular",
    "later-qualified-evidence",
    String(unresolvedPublication.document.resulting_revision_id),
    supplemental,
  );
  expect(replay.records.cards!.map(({ id }) => id)).toEqual(established.records.cards!.map(({ id }) => id));
  const inspected = await get(`/v1/entity-proposals/${proposal.id}`);
  expect(inspected.document).toMatchObject({ status: "rejected", generation: 1 });
  expect(inspected.document.history).toHaveLength(1);
  const replayPublication = await approveNativeCandidate(replay.candidate, "rejected-evidence-publication");
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
  const reconsidered = await prepareAdmissionSource(
    "/reconciliation/canonical-tabular",
    "owner-reconsidered",
    String(replayPublication.document.resulting_revision_id),
    supplemental,
  );
  expect(reconsidered.records.printings).toHaveLength(1);
  expect((await get(`/v1/entity-proposals/${proposal.id}`)).document.history).toHaveLength(3);
});

test.each(["canonical-tabular", "canonical-tabular-missing-number"])(
  "later publisher confirmation keeps supplemental IDs and authority: %s",
  async (scenario) => {
    await designateSupplemental();
    const initial = await prepareAdmissionSource(
      `/reconciliation/${scenario}`,
      "supplemental-first",
      "catrev_spine_000",
      supplemental,
    );
    if (scenario.endsWith("missing-number")) {
      expect(initial.records.cards).toEqual([
        expect.objectContaining({ official_identity: { kind: "unknown", value: null } }),
      ]);
    }
    const initialPublication = await approveNativeCandidate(initial.candidate, "supplemental-first-publication");
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
    const confirmed = await prepareNativeCandidate(
      String(started.document.id),
      "one-piece",
      String(initialPublication.document.resulting_revision_id),
      "publisher-confirmation-candidate",
    );
    const confirmedRecords = await nativeCandidateRecords(String(confirmed.id));
    expect(confirmedRecords.cards).toEqual([
      expect.objectContaining({
        id: (initial.records.cards as { id: string }[])[0]!.id,
        official_identity: { kind: "card_number", value: "OP96-001" },
      }),
    ]);
    const beforePrinting = (initial.records.printings as { id: string }[])[0]!;
    expect(confirmedRecords.printings).toEqual([expect.objectContaining({ id: beforePrinting.id })]);
    const mapping = await get(`/v1/reconciliation/identities/${beforePrinting.id}?preparation_id=${confirmed.id}`);
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
  const initial = await prepareAdmissionSource(
    "/reconciliation/card-without-printing",
    "link-target",
    "catrev_spine_000",
  );
  await approveNativeCandidate(initial.candidate, "link-target-publication");
  const card = (initial.records.cards as { id: string; [key: string]: unknown }[])[0]!;
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
  const initial = await prepareAdmissionSource(
    "/reconciliation/canonical-tabular",
    "reaffirm-initial",
    "catrev_spine_000",
    supplemental,
  );
  const publication = await approveNativeCandidate(initial.candidate, "reaffirm-initial-publication");
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
  const printing = (initial.records.printings as { id: string }[])[0]!;
  expect((reaffirmed.document.history as { decision: unknown }[])[2]!.decision).toMatchObject({
    printing: { id: printing.id },
  });
  const updated = await prepareAdmissionSource(
    "/reconciliation/canonical-tabular-unrelated",
    "unrelated-metadata",
    String(publication.document.resulting_revision_id),
    supplemental,
  );
  expect(updated.records.printings).toEqual([
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
  const candidate = await prepareAdmissionSource(
    "/reconciliation/card-without-printing",
    "unknown-printing-candidate",
    "catrev_spine_000",
  );
  expect([...(candidate.records.warnings ?? []), ...(candidate.records.shared_warnings ?? [])]).toEqual(
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
  const candidate = await prepareAdmissionSource(
    "/reconciliation/card-without-printing",
    "identity-publish",
    "catrev_spine_000",
  );
  await approveNativeCandidate(candidate.candidate, "identity-publication");
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

test.each([
  { actor: "automation", action: "admit", hasPrinting: true, permitted: false },
  { actor: "owner", action: "admit", hasPrinting: false, permitted: false },
  { actor: "owner", action: "link", hasPrinting: false, permitted: false },
  { actor: "owner", action: "admit", hasPrinting: true, permitted: true },
  { actor: "owner", action: "link", hasPrinting: true, permitted: true },
])(
  "owner Printing review respects retained $actor $action (Printing: $hasPrinting)",
  async ({ actor, action, hasPrinting, permitted }) => {
    await designateSupplemental();
    const run = await collect("/reconciliation/canonical-tabular", "owner-printing-policy", supplemental);
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    const at = new Date().toISOString();
    await initializeReconciliationProgress(db, run.id, at);
    const snapshot = (run.document.snapshots as { id: string }[])[0];
    expect(snapshot).toBeDefined();
    const document = reconciliationSourceDocument(
      "inspection-base",
      "cards",
      "https://official-source.invalid/reconciliation/inspection-base",
    );
    const parsed = parseReconciliationObservation("review-observation", document.cards![0]);
    if (
      parsed.kind !== "card_printing" ||
      !parsed.observedCardAndPrinting.card ||
      !parsed.observedCardAndPrinting.printing
    )
      throw new Error("Expected synthetic Card and Printing");
    const observation = {
      ...parsed,
      sourceLineage: supplemental.lineage,
      sourceSnapshotId: snapshot!.id,
      sourceObservationSetId: "synthetic-set",
      demonstrablyNovel: true,
      noveltyProofComplete: true,
      artworkIdentityExplicit: true,
    };
    const required = { printingAdmission: "owner_review" as const };
    const initial = await assessSourceAdmission(db, run.id, observation, at, required);
    expect(initial?.policy.automatic).toBe(true);
    expect(initial?.permitted).toBe(false);
    expect((await assessSourceAdmission(db, run.id, observation, at))?.permitted).toBe(true);
    const decision = {
      card: { ...parsed.observedCardAndPrinting.card, id: "reviewed-card" },
      printing: hasPrinting
        ? { ...parsed.observedCardAndPrinting.printing, id: "reviewed-printing", card_id: "reviewed-card" }
        : null,
    };
    await insertAdmissionDecisionStatement(
      db,
      {
        proposal_id: initial!.proposal.id,
        generation: 1,
        actor,
        action,
        rationale: "Retained decision before stricter Printing review",
        decision_json: JSON.stringify(decision),
        idempotency_key: "retained-review-decision",
        request_json: "{}",
        decided_at: at,
      },
      run.id,
    ).run();
    const assessed = await assessSourceAdmission(db, run.id, observation, at, required);
    expect(assessed?.permitted).toBe(permitted);
    expect(assessed?.decision).toEqual(decision);
    expect((await assessSourceAdmission(db, run.id, observation, at))?.permitted).toBe(true);
    const cardOnly = {
      ...observation,
      observedCardAndPrinting: { ...observation.observedCardAndPrinting, printing: null },
    };
    expect((await assessSourceAdmission(db, run.id, cardOnly, at, required))?.permitted).toBe(true);
    const history = await proposalHistoryStatement(db, initial!.proposal.id).all();
    expect(history.results).toEqual([
      expect.objectContaining({ actor, action, decision_json: JSON.stringify(decision) }),
    ]);
  },
);
