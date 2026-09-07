import { expect, test } from "vitest";
import worker from "../src/index";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import {
  get,
  collect,
  reconcile,
  approve,
  installReconciliationSuite,
  post,
  postFixtureEvidence,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("preparation checks its game predecessor independently of another game's publication", async () => {
  const seed = await collect("/reconciliation/base", "native-predecessor-seed");
  const published = await approve((await reconcile(seed.id)).document);
  expect(published.response.status).toBe(200);
  const revision = requiredString(published.document, "resulting_revision_id");
  const onePiece = await collect("/reconciliation/base", "native-predecessor-next");
  const stale = await post("/v1/game-candidates", {
    ingestion_run_id: onePiece.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-stale-predecessor",
  });
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({ code: "game_revision_mismatch" });
  const current = await post("/v1/game-candidates", {
    ingestion_run_id: onePiece.id,
    supported_game: "one-piece",
    expected_game_revision_id: revision,
    idempotency_key: "native-current-predecessor",
  });
  expect(current.response.status, JSON.stringify(current.document)).toBe(201);
  const fusion = await collect("/reconciliation/profile-fusion-world", "native-unrelated-predecessor", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const unrelated = await post("/v1/game-candidates", {
    ingestion_run_id: fusion.id,
    supported_game: "fusion-world",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-unrelated-game",
  });
  expect(unrelated.response.status, JSON.stringify(unrelated.document)).toBe(201);
  for (const candidate of [current, unrelated]) {
    const id = requiredString(candidate.document, "id");
    const deadline = Date.now() + 15000;
    let status = (await get(`/v1/game-candidates/${id}`)).document;
    while (status.state === "preparing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await get(`/v1/game-candidates/${id}`)).document;
    }
    expect(status, JSON.stringify(status)).toMatchObject({
      state: "sealed",
      expected_game_revision_id: candidate.document.expected_game_revision_id,
    });
  }
});

test.each([
  ["capacity-high-degree-observation", "reconciliation_capacity_exceeded"],
  ["identity-whitespace", "retained_evidence_invalid"],
  ["not-demonstrably-novel", "printing_reconciliation_blocked"],
])("a game preparation reports terminal %s failure without failing its collection", async (fixture, code) => {
  const run = await collect(`/reconciliation/${fixture}`, "native-failure-evidence");
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-capacity-intent",
  };
  const created = await post("/v1/game-candidates", intent);
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    state: "failed",
    failure_code: code,
    outcome: {
      preparation_id: id,
      run_id: run.id,
      state: "failed",
      failure_code: code,
      diagnostics: expect.any(Array),
    },
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  expect((await post("/v1/game-candidates", intent)).document).toEqual(candidate);
  const replayedWorkflow = await runReconciliationWorkflow(
    testEnv,
    {
      instanceId: `native-replay-${fixture}`,
      payload: {
        ingestion_run_id: run.id,
        preparation_id: id,
        expected_current_revision_id: intent.expected_game_revision_id,
        idempotency_key: intent.idempotency_key,
        observed_at: String(created.document.created_at),
        generation: 0,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect(JSON.parse(replayedWorkflow.result_json).result).toEqual(candidate.outcome);
  expect((await get(`/v1/game-candidates/${id}`)).document).toEqual(candidate);

  if (fixture === "not-demonstrably-novel") {
    const partitions = (await get(`/v1/game-candidates/${id}/partitions`)).document.partitions as {
      ordinal: number;
      kind: string;
    }[];
    const warnings = partitions.filter((part) => part.kind === "warnings" || part.kind === "shared_warnings");
    expect(warnings.length).toBeGreaterThan(0);
    const records: Record<string, unknown>[] = [];
    for (const warning of warnings)
      records.push(
        ...((await get(`/v1/game-candidates/${id}/partitions/${warning.ordinal}`)).document.records as Record<
          string,
          unknown
        >[]),
      );
    expect(records).toContainEqual(expect.objectContaining({ code: "printing_match_insufficient_evidence" }));
  }
});

test("two games from one collection prepare independently while one operation is paused", async () => {
  const collected = await postFixtureEvidence({
    idempotency_key: "independent-game-collection",
    plans: [
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@3",
        requests: [
          { id: "one-piece-en:discovery", url: "https://official-source.invalid/reconciliation/game-scoped-warning" },
        ],
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@2",
        requests: [
          {
            id: "fusion-world-en:discovery",
            url: "https://official-source.invalid/reconciliation/profile-fusion-world",
          },
        ],
      },
    ],
  });
  expect(collected.response.status).toBe(201);
  const runId = requiredString(collected.document, "id");
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    runId,
  );
  const intent = {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "independent-one-piece",
  };
  const first = await post("/v1/game-candidates", intent);
  expect(first.response.status).toBe(201);
  const firstId = requiredString(first.document, "id");
  const paused = await post(`/v1/game-candidates/${firstId}/pause`, {
    generation: 0,
    idempotency_key: "pause-one-piece",
  });
  expect(paused.response.status).toBe(200);
  expect(paused.document).toMatchObject({ state: "paused", generation: 1, deadline: first.document.deadline });

  const second = await post("/v1/game-candidates", {
    ...intent,
    supported_game: "fusion-world",
    idempotency_key: "independent-fusion-world",
  });
  expect(second.response.status).toBe(201);
  const secondId = requiredString(second.document, "id");
  expect(secondId).not.toBe(firstId);
  const deadline = Date.now() + 15000;
  let sealed = (await get(`/v1/game-candidates/${secondId}`)).document;
  while (sealed.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    sealed = (await get(`/v1/game-candidates/${secondId}`)).document;
  }
  expect(sealed, JSON.stringify(sealed)).toMatchObject({
    state: "sealed",
    generation: 0,
    deadline: second.document.deadline,
  });
  expect((await get(`/v1/game-candidates/${firstId}`)).document).toMatchObject({
    state: "paused",
    generation: 1,
    deadline: first.document.deadline,
  });
  const replay = await post("/v1/game-candidates", intent);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toMatchObject({ id: firstId, state: "paused" });
  const inputs = await get(`/v1/game-candidates/${secondId}/inputs`);
  expect(inputs.response.status).toBe(200);
  expect(inputs.document).toMatchObject({ ingestion_run_id: runId, preparation_id: secondId, verified: true });
  const observations: Record<string, unknown>[] = [];
  for (const partition of inputs.document.partitions as { kind: string; ordinal: number }[]) {
    if (partition.kind !== "observations") continue;
    const detail = await get(`/v1/game-candidates/${secondId}/inputs/${partition.ordinal}`);
    expect(detail.response.status).toBe(200);
    observations.push(...(detail.document.records as Record<string, unknown>[]));
  }
  expect(observations.length).toBeGreaterThan(0);
  expect(observations.map((observation) => observation.sourceLineage)).toEqual(
    observations.map(() => "fusion-world-en"),
  );
  const resumed = await post(`/v1/game-candidates/${firstId}/resume`, {
    generation: 1,
    idempotency_key: "resume-one-piece",
  });
  expect(resumed.response.status).toBe(200);
  expect(resumed.document).toMatchObject({ state: "preparing", generation: 1, deadline: first.document.deadline });
  const resumedDeadline = Date.now() + 15000;
  let completed = (await get(`/v1/game-candidates/${firstId}`)).document;
  while (completed.state === "preparing" && Date.now() < resumedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = (await get(`/v1/game-candidates/${firstId}`)).document;
  }
  expect(completed, JSON.stringify(completed)).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: first.document.deadline,
  });
  expect((await get(`/v1/game-candidates/${secondId}`)).document).toMatchObject({ state: "sealed", generation: 0 });
});

test("abandonment releases only its game slot and a new intent creates a fresh candidate from the same collection", async () => {
  const run = await collect("/reconciliation/base", "fresh-game-preparation");
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "first-game-intent",
  };
  const first = await post("/v1/game-candidates", intent);
  expect(first.response.status).toBe(201);
  const id = requiredString(first.document, "id");
  expect(
    (await post(`/v1/game-candidates/${id}/pause`, { generation: 0, idempotency_key: "pause-before-abandon" })).response
      .status,
  ).toBe(200);
  const occupied = await post("/v1/game-candidates", { ...intent, idempotency_key: "competing-game-intent" });
  expect(occupied.response.status).toBe(409);
  expect(occupied.document).toMatchObject({ code: "game_candidate_slot_occupied" });
  const expired = await post(
    `/v1/game-candidates/${id}/resume`,
    { generation: 1, idempotency_key: "expired-game-resume" },
    { "x-keepr-test-now": new Date(Date.parse(String(first.document.deadline)) + 1).toISOString() },
  );
  expect(expired.response.status).toBe(409);
  expect(expired.document).toMatchObject({ code: "reconciliation_deadline_expired" });
  const changed = await post("/v1/game-candidates", { ...intent, supported_game: "fusion-world" });
  expect(changed.response.status).toBe(409);
  expect(changed.document).toMatchObject({ code: "idempotency_conflict" });
  const abandoned = await post(`/v1/game-candidates/${id}/abandon`, {
    generation: 1,
    idempotency_key: "abandon-game-intent",
  });
  expect(abandoned.response.status).toBe(200);
  expect(abandoned.document).toMatchObject({ state: "abandoned", generation: 2, deadline: first.document.deadline });
  const fresh = await post("/v1/game-candidates", { ...intent, idempotency_key: "competing-game-intent" });
  expect(fresh.response.status, JSON.stringify(fresh.document)).toBe(201);
  expect(fresh.document.id).not.toBe(id);
  expect(fresh.document).toMatchObject({ ingestion_run_id: run.id, generation: 0 });
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
    state: "abandoned",
    generation: 2,
    deadline: first.document.deadline,
  });
  const replay = await post("/v1/game-candidates", intent);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toMatchObject({ id, state: "abandoned" });
});

test("a native source change retains reconfirmable curated diagnostics without failing the collection", async () => {
  const seed = await reconcile(
    (await collect("/reconciliation/curated-conflict-fanout-base", "native-curated-seed")).id,
  );
  const card = (seed.document.cards as { id: string; name: string }[])[0]!;
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: card.id, path: "/name" },
    assertion: { kind: "field", value: "Synthetic curated name" },
    rationale: "Synthetic reviewed correction",
    evidence: [{ kind: "owner_reference", uri: "https://owner.example/native-review", content_digest: "a".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(card.name)),
    supersedes_revision_id: null,
  };
  const revision = await post("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: published.document.resulting_revision_id,
    proposal,
    proposal_digest: await sha256Text(canonicalJson(proposal)),
    idempotency_key: "native-curated-revision",
  });
  expect(revision.response.status).toBe(201);
  const revisionId = requiredString(revision.document, "curated_revision_id");
  const run = await collect("/reconciliation/curated-conflict-fanout-changed", "native-curated-next");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "native-curated-candidate",
  });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  const status = (await get(`/admin/v1/curated-revisions/${revisionId}`)).document;
  expect(status).toMatchObject({
    revision: { status: "reconfirmation_required", pending_conflict: { preparation_id: id, run_id: run.id } },
  });
  const pending = status.revision as { pending_conflict: { digest: string }; event_version: number };
  const reaffirmed = await post(`/admin/v1/curated-revisions/${revisionId}/reaffirm`, {
    environment: "production",
    expected_current_revision_id: published.document.resulting_revision_id,
    expected_event_version: pending.event_version,
    conflict_digest: pending.pending_conflict.digest,
    rationale: "Synthetic owner confirms changed source",
    idempotency_key: "native-curated-reaffirm",
  });
  // The legacy collection reservation remains live until the collection adapter completes it.
  expect(reaffirmed.response.status).toBe(409);
  expect(reaffirmed.document).toMatchObject({ code: "active_ingestion_run" });
});

test("a fresh native preparation pins later owner corrections and retains them across retirement", async () => {
  const source = await collect("/reconciliation/base", "native-fresh-curated-source");
  const seed = await reconcile(source.id);
  const card = (seed.document.cards as { id: string; name: string }[])[0]!;
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: card.id, path: "/name" },
    assertion: { kind: "field", value: "Owner correction after collection" },
    rationale: "Reviewed correction over retained source evidence",
    evidence: [{ kind: "owner_reference", uri: "https://owner.example/fresh-review", content_digest: "b".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(card.name)),
    supersedes_revision_id: null,
  };
  const revision = await post("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: published.document.resulting_revision_id,
    proposal,
    proposal_digest: await sha256Text(canonicalJson(proposal)),
    idempotency_key: "native-fresh-curated-revision",
  });
  expect(revision.response.status).toBe(201);
  let params: ReconciliationWorkflowParams | undefined;
  const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return queued;
    },
    get: async () => queued,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const created = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/game-candidates", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: source.id,
        supported_game: "one-piece",
        expected_game_revision_id: published.document.resulting_revision_id,
        idempotency_key: "native-fresh-curated-preparation",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: binding },
  );
  expect(created.status).toBe(201);
  const id = requiredString(await created.json<Record<string, unknown>>(), "id");
  const retired = await post(`/admin/v1/curated-revisions/${revision.document.curated_revision_id}/retire`, {
    environment: "production",
    expected_current_revision_id: published.document.resulting_revision_id,
    expected_event_version: 1,
    conflict_digest: null,
    rationale: "Later retirement must not change an existing preparation's exact pins.",
    idempotency_key: "native-fresh-curated-retire",
  });
  expect(retired.response.status, JSON.stringify(retired.document)).toBe(200);
  expect(params).toBeDefined();
  await runReconciliationWorkflow(
    testEnv,
    {
      instanceId: "native-curated-frozen",
      payload: params!,
    } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
  const partitions = (await get(`/v1/game-candidates/${id}/partitions`)).document.partitions as {
    kind: string;
    ordinal: number;
  }[];
  const cards = partitions.find((partition) => partition.kind === "cards")!;
  expect(cards).toBeDefined();
  const records = (await get(`/v1/game-candidates/${id}/partitions/${cards.ordinal}`)).document.records;
  expect(records).toContainEqual(expect.objectContaining({ id: card.id, name: "Owner correction after collection" }));
});

test("a delayed native worker fails at its original deadline without sealing or renewing its intent", async () => {
  const run = await collect("/reconciliation/base", "expired-native-evidence");
  const createdAt = new Date(Date.now() - 8 * 86400000).toISOString();
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "expired-native-intent",
  };
  const created = await post("/v1/game-candidates", intent, { "x-keepr-test-now": createdAt });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    state: "failed",
    failure_code: "reconciliation_deadline_expired",
    deadline: new Date(Date.parse(createdAt) + 7 * 86400000).toISOString(),
  });
  expect((await post("/v1/game-candidates", intent)).document).toEqual(candidate);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});

test("native supplemental admission retains collection evidence and preparation-owned mappings", async () => {
  for (const area of ["card_facts", "printing_details"]) {
    expect(
      (
        await post("/v1/source-authorities", {
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic native admission",
          idempotency_key: `native-admission-${area}`,
        })
      ).response.status,
    ).toBe(200);
  }
  const run = await collect("/reconciliation/canonical-tabular", "native-admission-evidence", {
    game: "one-piece",
    lineage: "limitless-one-piece-en",
    adapter: "fixture-one-piece-tabular@1",
  });
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-admission-intent",
  });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
  const proposals = (await get("/v1/entity-proposals?game=one-piece")).document.proposals as Record<string, unknown>[];
  expect(proposals).toEqual([
    expect.objectContaining({ status: "admitted", source_lineage: "limitless-one-piece-en" }),
  ]);
  const partitions = (await get(`/v1/game-candidates/${id}/partitions`)).document.partitions as {
    ordinal: number;
    kind: string;
  }[];
  const printingPartition = partitions.find((partition) => partition.kind === "printings")!;
  expect(printingPartition).toBeDefined();
  const printing = (
    (await get(`/v1/game-candidates/${id}/partitions/${printingPartition.ordinal}`)).document.records as {
      id: string;
    }[]
  )[0]!;
  const mappings = (await get(`/v1/reconciliation/identities/${printing.id}?preparation_id=${id}`)).document.mappings;
  expect(mappings).toEqual([expect.objectContaining({ preparation_id: id, ingestion_run_id: run.id })]);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});

test("native ambiguous matches retain review evidence under their preparation and source collection", async () => {
  const seed = await reconcile(
    (await collect("/reconciliation/canonical-official-ambiguous", "native-review-seed")).id,
  );
  const printingId = (seed.document.printings as { id: string }[])[0]!.id;
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  for (const area of ["card_facts", "printing_details"]) {
    expect(
      (
        await post("/v1/source-authorities", {
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic native review",
          idempotency_key: `native-review-${area}`,
        })
      ).response.status,
    ).toBe(200);
  }
  const run = await collect("/reconciliation/canonical-tabular-ambiguous", "native-review-evidence", {
    game: "one-piece",
    lineage: "limitless-one-piece-en",
    adapter: "fixture-one-piece-tabular@1",
  });
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "native-review-intent",
  });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    state: "failed",
    failure_code: "printing_reconciliation_blocked",
  });
  const reviews = await get(`/v1/reconciliation/identity-reviews?preparation_id=${id}`);
  expect(reviews.response.status).toBe(200);
  expect(reviews.document.reviews).toEqual([
    expect.objectContaining({
      preparation_id: id,
      ingestion_run_id: run.id,
      source_lineage: "limitless-one-piece-en",
      candidate_printing_ids: [printingId],
      evidence: expect.any(Object),
    }),
  ]);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});
