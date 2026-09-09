import { expect, test } from "vitest";
import { replaceGameCandidateProvenance } from "./query-helpers/game-candidates";
import {
  collect,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("a sealed candidate retains its original collection provenance when another collection exists", async () => {
  const first = await collect("/reconciliation/base", "immutable-candidate-first");
  const result = await reconcile(first.id);
  expect(result.response.status).toBe(200);
  const status = await get(`/v1/ingestion-runs/${first.id}/reconciliation`);
  const candidates = status.document.candidates as { id: string }[];
  const candidateId = candidates[0]!.id;
  const original = await get(`/v1/game-candidates/${candidateId}`);
  expect(original.document.ingestion_run_id).toBe(first.id);
  const published = await post(`/v1/ingestion-runs/${first.id}/approval`, {
    candidate_digest: requiredString(result.document, "candidate_digest"),
    expected_current_revision_id: requiredString(result.document, "expected_current_revision_id"),
    idempotency_key: "immutable-candidate-publish",
  });
  expect(published.response.status).toBe(200);
  const second = await collect("/reconciliation/base", "immutable-candidate-second");
  expect(second.id).not.toBe(first.id);
  const beforeMutation = await get(`/v1/game-candidates/${candidateId}`);
  await expect(replaceGameCandidateProvenance(testEnv.CATALOGUE_DB).bind(second.id, candidateId).run()).rejects.toThrow(
    "game_candidate_identity_immutable",
  );
  expect((await get(`/v1/game-candidates/${candidateId}`)).document).toEqual(beforeMutation.document);
});

test("reusing a published collection retains native mapping ownership separately from published mappings", async () => {
  const run = await collect("/reconciliation/base", "native-mapping-published-source");
  const reconciled = await reconcile(run.id);
  const printingId = (reconciled.document.printings as { id: string }[])[0]!.id;
  const published = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    expected_current_revision_id: requiredString(reconciled.document, "expected_current_revision_id"),
    idempotency_key: "native-mapping-publish-source",
  });
  expect(published.response.status).toBe(200);
  const original = (await get(`/v1/reconciliation/identities/${printingId}`)).document;
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "native-mapping-reuse-source",
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
  const audit = await get(`/v1/reconciliation/identities/${printingId}?preparation_id=${id}`);
  expect(audit.response.status).toBe(200);
  expect(audit.document.mappings).toEqual([
    expect.objectContaining({ preparation_id: id, ingestion_run_id: run.id, publication_state: "sealed" }),
  ]);
  expect((await get(`/v1/reconciliation/identities/${printingId}`)).document).toEqual(original);
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "published" });
});

test("candidate partition inspection rejects a mixed manifest pin and returns verified content identity", async () => {
  const run = await collect("/reconciliation/base", "inspection-pin");
  await reconcile(run.id);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const id = (status.document.candidates as { id: string }[])[0]!.id;
  const candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const wrong = await get(`/v1/game-candidates/${id}/partitions/0?manifest=${"0".repeat(64)}`);
  expect(wrong.response.status).toBe(409);
  const detail = await get(`/v1/game-candidates/${id}/partitions/0?manifest=${candidate.manifest_digest}`);
  expect(detail.response.status).toBe(200);
  expect(detail.document).toMatchObject({
    candidate_id: id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
  });
});

test("owner inspection retains complete proposed values and semantic differences against its exact predecessor", async () => {
  const run = await collect("/reconciliation/base", "inspection-values");
  await reconcile(run.id);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const id = (status.document.candidates as { id: string }[])[0]!.id;
  const pages = await get(`/v1/game-candidates/${id}/partitions`);
  const inspection = (pages.document.partitions as { kind: string; ordinal: number }[]).filter(
    (p) => p.kind === "inspection",
  );
  expect(inspection.length).toBeGreaterThan(0);
  const details = await Promise.all(inspection.map((p) => get(`/v1/game-candidates/${id}/partitions/${p.ordinal}`)));
  const records = details.flatMap((p) => p.document.records as Record<string, unknown>[]);
  expect(records).toContainEqual(
    expect.objectContaining({
      entity_class: "cards",
      change: "added",
      before: null,
      after: expect.objectContaining({ name: "Monkey.D.Luffy" }),
      expected_game_revision_id: "catrev_spine_000",
    }),
  );
});

for (const change of ["product", "release", "image", "evidence"]) {
  test(`synthetic ${change}-only refresh has complete native candidate inspection`, async () => {
    const base = await collect("/reconciliation/inspection-base", `inspection-${change}-base`);
    const result = await reconcile(base.id);
    const published = await post(`/v1/ingestion-runs/${base.id}/approval`, {
      candidate_digest: result.document.candidate_digest,
      expected_current_revision_id: result.document.expected_current_revision_id,
      idempotency_key: `inspection-${change}-publish`,
    });
    expect(published.response.status).toBe(200);
    const next = await collect(`/reconciliation/inspection-${change}`, `inspection-${change}-next`);
    const created = await post("/v1/game-candidates", {
      ingestion_run_id: next.id,
      supported_game: "one-piece",
      expected_game_revision_id: published.document.resulting_revision_id,
      idempotency_key: `inspection-${change}-native`,
    });
    expect(created.response.status).toBe(201);
    const id = requiredString(created.document, "id");
    const deadline = Date.now() + 15000;
    let candidate = (await get(`/v1/game-candidates/${id}`)).document;
    while (candidate.state === "preparing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      candidate = (await get(`/v1/game-candidates/${id}`)).document;
    }
    expect(candidate).toMatchObject({ state: "sealed" });
    const { nativeCandidateRecords } = await import("./native-candidate-helpers");
    const records = await nativeCandidateRecords(id);
    const differences = records.inspection!;
    const summary = await get(`/v1/game-candidates/${id}/inspection?manifest=${candidate.manifest_digest}`);
    expect(summary.response.status, JSON.stringify(summary.document)).toBe(200);
    expect(summary.document).toMatchObject({
      ready: true,
      record_count: differences.length,
      approval_scope: "whole_candidate",
      expected_game_revision_id: published.document.resulting_revision_id,
    });
    expect(differences).toContainEqual(
      expect.objectContaining({
        entity_class: "cards",
        change: "carry_forward",
        before: expect.objectContaining({ name: "Inspection Card" }),
        after: expect.objectContaining({ name: "Inspection Card" }),
      }),
    );
    if (change === "product")
      expect(differences).toContainEqual(
        expect.objectContaining({
          entity_class: "products",
          change: "changed",
          before: expect.objectContaining({ name: "Inspection Product" }),
          after: expect.objectContaining({ name: "Revised Product" }),
        }),
      );
    if (change === "release")
      expect(differences).toContainEqual(
        expect.objectContaining({
          entity_class: "products",
          change: "changed",
          before: expect.objectContaining({
            releases: [expect.objectContaining({ date: { precision: "month", value: "2026-09" } })],
          }),
          after: expect.objectContaining({
            releases: [expect.objectContaining({ date: { precision: "month", value: "2026-10" } })],
          }),
        }),
      );
    if (change === "image")
      expect(differences.some((row) => row.entity_class === "printing_images" && row.change !== "carry_forward")).toBe(
        true,
      );
    if (change === "evidence")
      expect(differences).toContainEqual(
        expect.objectContaining({ entity_class: "products", change: "evidence_only" }),
      );
    const evidence = await get(`/v1/game-candidates/${id}/inspection/evidence/identity`);
    expect(evidence.response.status).toBe(200);
    expect((evidence.document.records as unknown[]).length).toBe(1);
    const mixed = await get(`/v1/game-candidates/${id}/partitions?after=${"0".repeat(64)}:0`);
    expect(mixed.response.status).toBe(409);
  });
}

test("owner image inspection verifies bytes and injected missing images fail closed", async () => {
  const { default: worker } = await import("../src/index");
  const run = await collect("/reconciliation/base", "inspection-image-download");
  await reconcile(run.id);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const id = (status.document.candidates as { id: string }[])[0]!.id;
  const page = await get(`/v1/game-candidates/${id}/partitions`);
  const image = (page.document.partitions as { ordinal: number; kind: string }[]).find(
    (p) => p.kind === "printing_images",
  )!;
  const details = await get(`/v1/game-candidates/${id}/partitions/${image.ordinal}`);
  const metadata = (details.document.records as { object_key: string; content_byte_length: number }[])[0]!;
  const request = () =>
    new Request(`https://card-keepr.invalid/v1/game-candidates/${id}/partitions/${image.ordinal}/images/0`, {
      headers: { authorization: "Bearer vitest-administration-key" },
    });
  const response = await worker.fetch(request(), testEnv);
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBe(metadata.content_byte_length);
  // Explicit injected storage loss, not a finding about retained real-source evidence.
  await testEnv.PRINTING_IMAGES.delete(metadata.object_key);
  const missing = await worker.fetch(request(), testEnv);
  expect(missing.status).toBe(409);
});

test("injected corrupt inspection summary cannot report readiness", async () => {
  const { default: worker } = await import("../src/index");
  const run = await collect("/reconciliation/base", "inspection-corrupt-summary");
  await reconcile(run.id);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const id = (status.document.candidates as { id: string }[])[0]!.id;
  const statement = (original: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(original, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        if (property === "first")
          return async (...args: unknown[]) => {
            const value = await Reflect.apply(target.first, target, args);
            return value && typeof value === "object" && "kind" in value && value.kind === "inspection_summary"
              ? { ...value, sha256: "0".repeat(64) }
              : value;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/game-candidates/${id}/inspection`, {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
    { ...testEnv, CATALOGUE_DB: database },
  );
  expect(response.status).toBe(409);
});

test("injected loss of a replaced before-image prevents a native inspection integrity receipt", async () => {
  const base = await collect("/reconciliation/deterministic-forward", "inspection-before-image-base");
  const result = await reconcile(base.id);
  const published = await post(`/v1/ingestion-runs/${base.id}/approval`, {
    candidate_digest: result.document.candidate_digest,
    expected_current_revision_id: result.document.expected_current_revision_id,
    idempotency_key: "inspection-before-image-publish",
  });
  expect(published.response.status).toBe(200);
  const status = await get(`/v1/ingestion-runs/${base.id}/reconciliation`);
  const priorId = (status.document.candidates as { id: string }[])[0]!.id;
  const { nativeCandidateRecords } = await import("./native-candidate-helpers");
  const previous = await nativeCandidateRecords(priorId);
  const printings = result.document.printings as { id: string }[];
  const correction = {
    game: "one-piece",
    entity_kind: "printing",
    action: "merge",
    source_ids: [printings[0]!.id],
    replacement_ids: [printings[1]!.id],
    printing_assignments: {},
    expected_current_revision_id: published.document.resulting_revision_id,
    rationale: "Synthetic owner identity correction for inspection",
    evidence: { attestation: "Synthetic owner review of both retained Printings" },
  };
  const validation = await post("/v1/identity-corrections/validate", correction);
  expect(validation.response.status, JSON.stringify(validation.document)).toBe(200);
  expect(
    (
      await post("/v1/identity-corrections", {
        ...correction,
        review_digest: validation.document.review_digest,
        idempotency_key: "inspection-before-image-correction",
      })
    ).response.status,
  ).toBe(201);
  // Inject loss after owner review. This image will exist only in the before-value.
  const retiredImage = previous.printing_images!.find((image) => image.printing_id === printings[0]!.id)!;
  await testEnv.PRINTING_IMAGES.delete(String(retiredImage.object_key));
  const next = await collect("/reconciliation/card-without-printing", "inspection-before-image-next");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: next.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "inspection-before-image-native",
  });
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  const deadline = Date.now() + 15000;
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "paused", manifest_digest: null });
  expect((await get(`/v1/game-candidates/${id}/inspection`)).document).toMatchObject({ ready: false });
  expect((await get(`/v1/ingestion-runs/${next.id}`)).document).toMatchObject({ state: "parsing" });
});

test("canonical legacy candidate JSON preserves before-images regardless of member order", async () => {
  const { canonicalJson } = await import("../../../src/catalogue/shared");
  const { seedRunFixtureStatement } = await import("./query-helpers/run-events");
  const { nativeCandidateRecords } = await import("./native-candidate-helpers");
  const source = await collect("/reconciliation/base", "inspection-legacy-image-source");
  const reconciled = await reconcile(source.id);
  const status = await get(`/v1/ingestion-runs/${source.id}/reconciliation`);
  const candidateId = (status.document.candidates as { id: string }[])[0]!.id;
  const records = await nativeCandidateRecords(candidateId);
  expect(
    (
      await post(`/v1/ingestion-runs/${source.id}/rejection`, {
        candidate_digest: reconciled.document.candidate_digest,
        idempotency_key: "inspection-legacy-image-reject",
      })
    ).response.status,
  ).toBe(200);
  // Explicit legacy publication fixture: retained candidate JSON, without game partitions.
  const legacyId = "fixture_inspection_legacy_images";
  await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
    id: legacyId,
    state: "failed",
    started_at: "2000-01-01T00:00:00.000Z",
    terminal_at: "2000-01-01T00:00:00.000Z",
    selected_games_json: '["one-piece"]',
    failure_code: "fixture_source_ready",
    candidate_json: canonicalJson({
      contract: "card-keepr-catalogue-candidate@1",
      selected_games: ["one-piece"],
      cards: records.cards,
      printings: records.printings,
      printing_images: records.printing_images,
    }),
  }).run();
  const retried = await post(`/v1/ingestion-runs/${legacyId}/retry`, {
    idempotency_key: "inspection-legacy-image-retry",
  });
  expect(retried.response.status, JSON.stringify(retried.document)).toBe(201);
  const published = await post(`/v1/ingestion-runs/${retried.document.id}/approval`, {
    candidate_digest: retried.document.candidate_digest,
    expected_current_revision_id: retried.document.expected_current_revision_id,
    idempotency_key: "inspection-legacy-image-publish",
  });
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const next = await collect("/reconciliation/base", "inspection-legacy-image-next");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: next.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "inspection-legacy-image-native",
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
  const inspected = await nativeCandidateRecords(id);
  expect(inspected.inspection).toContainEqual(
    expect.objectContaining({
      entity_class: "printing_images",
      change: "carry_forward",
      before: expect.objectContaining({ role: "front" }),
      after: expect.objectContaining({ role: "front" }),
    }),
  );
});
