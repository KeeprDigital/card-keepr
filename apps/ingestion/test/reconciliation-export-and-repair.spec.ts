import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as cardSearchQueries from "./query-helpers/card-search";
import * as ingestionQueries from "./query-helpers/ingestion";
import { expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  canonicalJson,
  sha256,
  catalogueCandidateContract,
  catalogueRevisionIdentity,
} from "../../../src/catalogue/shared";
import { EMPTY_CATALOGUE_GZIP_HEX, GZIP_PROFILE_GOLDENS } from "./deterministic-gzip-golden";
import {
  installReconciliationSuite,
  testEnv,
  approve,
  collect,
  get,
  post,
  postFixtureEvidence,
  reconcile,
  requiredFirst,
  requiredString,
  waitForRunState,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("streamed catalogue gzip is byte-identical to the checked-in golden bytes", async () => {
  const built = await buildCatalogueExport(
    {
      contract: catalogueCandidateContract,
      selected_games: ["one-piece"],
      cards: [],
      printings: [],
      products: [],
      distribution_contexts: [],
      product_relationships: [],
      product_observed_games: [],
      product_observed_lineages: [],
    },
    "a".repeat(64),
    "catrev_gzip_golden",
    "2026-07-30T01:02:03.000Z",
  );
  const object = built.objects.find(({ contentEncoding }) => contentEncoding === "gzip");
  if (object === undefined) throw new Error("gzip component missing");
  const { readable, completed } = object.body();
  const bytes = new Uint8Array(await new Response(readable).arrayBuffer());
  await completed;
  expect(Buffer.from(bytes).toString("hex")).toBe(EMPTY_CATALOGUE_GZIP_HEX);
  expect([...bytes.slice(0, 10)]).toEqual([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff]);
  expect((bytes[10]! >> 1) & 0b11).toBe(0b01);
  expect(await sha256(bytes)).toBe(object.sha256);
});

test("every v2 export component orders opaque IDs by normalized UTF-8 bytes", async () => {
  const product = (id: string, releaseId: string) => ({
    reference: { kind: "official_code" as const, value: id },
    id,
    game: "one-piece" as const,
    official_code: id,
    name: id,
    releases: [
      {
        id: releaseId,
        event_key: releaseId,
        product_id: id,
        region: "unknown" as const,
        date: { precision: "unknown" as const, value: null },
        status: "announced" as const,
      },
    ],
    observed: true,
    withdrawal: null,
    included: [],
    provenance: {},
    disagreements: [],
    source_observations: [],
  });
  const built = await buildCatalogueExport(
    {
      contract: catalogueCandidateContract,
      selected_games: ["one-piece"],
      cards: [],
      printings: [],
      products: [
        product("product_Z", "release_Z"),
        product("product:A", "release:A"),
        product("product.a", "release.a"),
      ],
      distribution_contexts: [],
      product_relationships: [],
      product_observed_games: ["one-piece"],
      product_observed_lineages: ["one-piece-en"],
    },
    "f".repeat(64),
    "catrev_utf8_component_order",
    "2026-07-30T01:02:03.000Z",
  );
  const records = async (name: string) => {
    const index = built.manifest.components.findIndex((component) => component.name === name);
    const object = built.objects[index];
    if (object === undefined) throw new Error(`${name} component missing`);
    const { readable, completed } = object.body();
    const text = await new Response(readable.pipeThrough(new DecompressionStream("gzip"))).text();
    await completed;
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
  };

  expect((await records("products")).map(({ id }) => id)).toEqual(["product.a", "product:A", "product_Z"]);
  expect((await records("releases")).map(({ id }) => id)).toEqual(["release.a", "release:A", "release_Z"]);
});

test("deterministic gzip profile matches independent full-byte edge-case goldens", async () => {
  const candidateProduct = (id: string, officialCode: string | null, name: string | null) => ({
    reference: {
      kind: officialCode === null ? ("name" as const) : ("official_code" as const),
      value: officialCode ?? name ?? id,
    },
    id,
    game: "one-piece" as const,
    official_code: officialCode,
    name,
    releases: [],
    observed: true,
    withdrawal: null,
    included: [],
    provenance: {},
    disagreements: [],
    source_observations: [],
  });
  const base = {
    contract: catalogueCandidateContract,
    selected_games: ["one-piece" as const],
    cards: [],
    printings: [],
    products: [],
    distribution_contexts: [],
    product_relationships: [],
    product_observed_games: [],
    product_observed_lineages: [],
  };
  const cases = [
    {
      name: "non_ascii_nfc" as const,
      component: 5,
      candidate: {
        ...base,
        products: [candidateProduct("product_nfc", "NFC-1", "Café Étude")],
      },
    },
    {
      name: "null_values" as const,
      component: 5,
      candidate: {
        ...base,
        products: [candidateProduct("product_null", null, null)],
      },
    },
    {
      name: "empty_component" as const,
      component: 3,
      candidate: base,
    },
    {
      name: "multiple_deflate_blocks" as const,
      component: 5,
      candidate: {
        ...base,
        // 80,257 canonical UTF-8 bytes cross the fixed-Huffman reference
        // encoder's DEFLATE block boundary.
        products: [candidateProduct("product_blocks", "BLOCKS", `Block ${"abcdef0123456789".repeat(5_000)}`)],
      },
    },
  ];
  for (const fixture of cases) {
    const built = await buildCatalogueExport(
      fixture.candidate,
      "b".repeat(64),
      `catrev_gzip_${fixture.name}`,
      "2026-07-30T01:02:03.000Z",
    );
    const object = built.objects[fixture.component];
    if (object === undefined) throw new Error("gzip component missing");
    const { readable, completed } = object.body();
    const hex = Buffer.from(await new Response(readable).arrayBuffer()).toString("hex");
    await completed;
    expect(hex).toBe(GZIP_PROFILE_GOLDENS[fixture.name]);
  }
}, 45_000);

test("heterogeneous empty plans inspect and publish every lineage independently of plan order", async () => {
  const seededRun = await collect("/reconciliation/profile-fusion-world", "mixed-plan-empty-lineage-seed", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const seeded = await reconcile(seededRun.id);
  const cardId = requiredString(requiredFirst(seeded.document, "cards"), "id");
  const printingId = requiredString(requiredFirst(seeded.document, "printings"), "id");
  expect((await approve(seeded.document)).response.status).toBe(200);

  const inspectOrder = async (lineages: readonly ("one-piece" | "fusion-world")[], suffix: string, publish = false) => {
    const started = await postFixtureEvidence({
      idempotency_key: `mixed-plan-empty-lineage-${suffix}`,
      plans: lineages.map((game) => ({
        supported_game: game,
        source_lineage: game === "one-piece" ? "one-piece-en" : "fusion-world-en",
        adapter_version: game === "one-piece" ? "fixture-one-piece-json@3" : "fixture-fusion-world-json@2",
        requests: [
          {
            id: `${game}-empty-${suffix}`,
            method: "GET" as const,
            url: "https://official-source.invalid/reconciliation/complete-empty-lineage",
            headers: { accept: "application/json" },
          },
        ],
      })),
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    expect((await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})).response.status).toBe(202);
    await waitForRunState(runId, "parsing");
    const candidate = await reconcile(runId);
    expect(candidate.response.status).toBe(200);
    const inspected = await get(`/v1/ingestion-runs/${runId}/candidate`);
    const result = {
      cards: (
        inspected.document.diff as {
          cards: { missing_observations: string[] };
        }
      ).cards.missing_observations,
      printings: (
        inspected.document.diff as {
          printings: { missing_observations: string[] };
        }
      ).printings.missing_observations,
    };
    if (publish) {
      const published = await approve(candidate.document);
      expect(published.response.status).toBe(200);
      const revisionId = requiredString(published.document, "resulting_revision_id");
      const lifecycle = await get(`/v1/reconciliation/printings/${printingId}`);
      expect(lifecycle.document).toMatchObject({
        locators: {
          current: [],
          historical: [
            expect.objectContaining({
              source_lineage: "fusion-world-en",
              current: false,
              last_missing_revision_id: revisionId,
            }),
          ],
        },
      });
    } else
      expect(
        (
          await post(`/v1/ingestion-runs/${runId}/rejection`, {
            candidate_digest: requiredString(candidate.document, "candidate_digest"),
            idempotency_key: `reject-mixed-plan-empty-lineage-${suffix}`,
          })
        ).response.status,
      ).toBe(200);
    return result;
  };

  const reversed = await inspectOrder(["fusion-world", "one-piece"], "reversed");
  const forward = await inspectOrder(["one-piece", "fusion-world"], "forward", true);
  expect(forward).toEqual(reversed);
  expect(forward.cards).toContain(cardId);
  expect(forward.printings).toContain(printingId);
}, 45_000);

test("Card search repair permits only retained revisions and revalidates unfinished replay claims", async () => {
  const publishScenario = async (sequence: number) => {
    const run = await collect(`/reconciliation/search-repair-retention-${sequence}`, `repair-retention-${sequence}`);
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
    return requiredString(published.document, "resulting_revision_id");
  };
  const revisionLineage = () =>
    publishedCatalogueQueries.inspectCatalogueState(testEnv.CATALOGUE_DB).all<{ revision_id: string; depth: number }>();
  let lineage = (await revisionLineage()).results;
  for (let sequence = 1; lineage.length < 5; sequence += 1) {
    await publishScenario(sequence);
    lineage = (await revisionLineage()).results;
  }
  const currentRevisionId = lineage[0]!.revision_id;
  const retained = await post("/v1/catalogue-search-materialization/repair", {
    target_revision_id: lineage[2]!.revision_id,
    expected_current_revision_id: currentRevisionId,
    idempotency_key: "repair-retained-second-predecessor",
  });
  expect(retained.response.status).toBe(200);

  const archived = await post("/v1/catalogue-search-materialization/repair", {
    target_revision_id: lineage[3]!.revision_id,
    expected_current_revision_id: currentRevisionId,
    idempotency_key: "reject-archived-repair-target",
  });
  expect(archived.response.status).toBe(409);
  expect(archived.document).toMatchObject({
    code: "catalogue_revision_not_repairable",
  });

  const unfinishedRequest = {
    target_revision_id: currentRevisionId,
    expected_current_revision_id: currentRevisionId,
    idempotency_key: "stale-unfinished-repair-replay",
  };
  await publishedCatalogueQueries
    .insertCatalogueSearchRepairRequests(testEnv.CATALOGUE_DB)
    .bind(
      unfinishedRequest.idempotency_key,
      unfinishedRequest.target_revision_id,
      unfinishedRequest.expected_current_revision_id,
      canonicalJson(unfinishedRequest),
      canonicalJson({
        contract: "card-keepr-card-search-repair@1",
        complete: false,
        processed_cards: 25,
        revisions_available: 1,
        maximum_bound_parameter_bytes: 65_536,
      }),
    )
    .run();
  await publishScenario(5);

  const staleReplay = await post("/v1/catalogue-search-materialization/repair", unfinishedRequest);
  expect(staleReplay.response.status).toBe(409);
  expect(staleReplay.document).toMatchObject({
    code: "current_revision_mismatch",
  });
}, 60_000);

test("Card search repair binds exact target/current/idempotency and fails stale or conflicting requests closed", async () => {
  const run = await collect("/reconciliation/complete-empty-lineage", "guarded-search-repair-published-target");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const request = {
    target_revision_id: revisionId,
    expected_current_revision_id: revisionId,
    idempotency_key: "guarded-search-repair",
  };
  const first = await post("/v1/catalogue-search-materialization/repair", request);
  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-search-repair@1",
    complete: expect.any(Boolean),
  });
  const replay = await post("/v1/catalogue-search-materialization/repair", request);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(first.document);

  const conflict = await post("/v1/catalogue-search-materialization/repair", {
    ...request,
    target_revision_id: "catrev_conflicting_repair_target",
  });
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({ code: "idempotency_conflict" });

  const stale = await post("/v1/catalogue-search-materialization/repair", {
    target_revision_id: revisionId,
    expected_current_revision_id: "catrev_stale_repair_current",
    idempotency_key: "guarded-search-repair-stale",
  });
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({ code: "current_revision_mismatch" });
}, 60_000);

test("publication and bounded Card search repair need no obsolete gram table and replay only their completed result", async () => {
  await cardSearchQueries.dropObsoleteCardSearchTerms(testEnv.CATALOGUE_DB).run();
  const run = await collect("/reconciliation/complete-empty-lineage", "bounded-25-card-search-repair");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const cards = Array.from({ length: 30 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const id = `card_bounded_search_repair_${ordinal}`;
    return {
      id,
      document: JSON.stringify({
        type: "card",
        id,
        game: "one-piece",
        official_identity: {
          kind: "card_number",
          value: `BOUND-${ordinal}`,
        },
        name: `Bounded repair Card ${ordinal}`,
        effective_rules_text: `Draw ${index + 1} cards.`,
        game_data: {},
        lifecycle: {},
        links: {},
      }),
    };
  });
  await testEnv.CATALOGUE_DB.batch([
    ...cards.map(({ id, document }) =>
      publishedCatalogueQueries
        .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
          testEnv.CATALOGUE_DB,
        )
        .bind(revisionId, id, document),
    ),
    publishedCatalogueQueries.deleteCatalogueQueryRevisions(testEnv.CATALOGUE_DB).bind(revisionId),
  ]);

  const repair = () =>
    post("/v1/catalogue-search-materialization/repair", {
      target_revision_id: revisionId,
      expected_current_revision_id: revisionId,
      idempotency_key: "bounded-25-card-search-repair",
    });
  const first = await repair();
  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-search-repair@1",
    complete: false,
    processed_cards: 25,
  });
  expect(Number(first.document.maximum_bound_parameter_bytes)).toBeLessThanOrEqual(65_536);

  const revisionCardCount = await publishedCatalogueQueries
    .countRevisionCardsCount(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .first<{ count: number }>();
  const maximumRepairCalls = Math.ceil(Number(revisionCardCount?.count ?? 0) / 25) + 1;
  let current = first;
  for (let call = 2; current.document.complete !== true && call <= maximumRepairCalls; call += 1) {
    current = await repair();
    expect(current.response.status).toBe(200);
    expect(current.document).toMatchObject({
      contract: "card-keepr-card-search-repair@1",
    });
    expect(Number(current.document.processed_cards)).toBeLessThanOrEqual(25);
    expect(Number(current.document.maximum_bound_parameter_bytes)).toBeLessThanOrEqual(65_536);
  }
  expect(current.document.complete).toBe(true);
  const replay = await repair();
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(current.document);
}, 60_000);

test("Card search repair rejects an oversized legacy Card before materializing it", async () => {
  const run = await collect("/reconciliation/base", "oversized-legacy-search-repair");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  const oversizedCardId = "card_oversized_legacy_search_repair";
  await testEnv.CATALOGUE_DB.batch([
    publishedCatalogueQueries
      .insertRevisionCardsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
        testEnv.CATALOGUE_DB,
      )
      .bind(
        revisionId,
        oversizedCardId,
        JSON.stringify({
          type: "card",
          id: oversizedCardId,
          game: "one-piece",
          official_identity: {
            kind: "card_number",
            value: "OVERSIZED-001",
          },
          name: "Oversized legacy Card",
          effective_rules_text: "x".repeat(65_536),
          game_data: {},
          lifecycle: {},
          links: {},
        }),
      ),
    publishedCatalogueQueries.deleteCatalogueQueryRevisions(testEnv.CATALOGUE_DB).bind(revisionId),
  ]);

  const repair = await post("/v1/catalogue-search-materialization/repair", {
    target_revision_id: revisionId,
    expected_current_revision_id: revisionId,
    idempotency_key: "reject-oversized-legacy-search-repair",
  });
  expect(repair.response.status).toBe(422);
  expect(repair.document).toMatchObject({
    code: "catalogue_search_repair_source_too_large",
    detail: "A retained Card exceeds the durable 65536-byte search repair source bound.",
  });
}, 60_000);

test("publication rejects an over-budget candidate before writing any immutable object", async () => {
  const run = await collect("/reconciliation/export-component-over-budget", "reconcile-export-component-over-budget");
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const currentBefore = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort();

  const blocked = await approve(reconciled.document);
  const objectsAfter = (await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort();
  const currentAfter = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();

  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "publication_aggregate_too_large",
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({
    state: "failed",
    failure_code: "publication_aggregate_too_large",
  });
  expect(objectsAfter).toEqual(objectsBefore);
  expect(currentAfter).toEqual(currentBefore);
});

test("an oversized legality relationship export fails terminally before reservation and replays the problem", async () => {
  const run = await collect(
    "/reconciliation/legality-relationship-over-budget",
    "reconcile-legality-relationship-over-budget",
    {
      game: "one-piece",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
    },
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.document).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
  });
  const approvalKey = "approve-legality-relationship-over-budget";
  const approvalRequest = {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    expected_current_revision_id: requiredString(reconciled.document, "expected_current_revision_id"),
    idempotency_key: approvalKey,
  };
  const currentBefore = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();
  const revisionsBefore = await publishedCatalogueQueries
    .countCatalogueRevisionsCount(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort();

  const blocked = await post(`/v1/ingestion-runs/${run.id}/approval`, approvalRequest);
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "catalogue_export_too_large",
  });

  const storedFailure = await ingestionQueries
    .readIngestionRunsStateFailureCode(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{ state: string; failure_code: string | null }>();
  expect(storedFailure).toEqual({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const shown = await get(`/v1/ingestion-runs/${run.id}`);
  expect(shown.response.status).toBe(200);
  expect(shown.document).toMatchObject({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const lifecycle = await ingestionQueries
    .countAdministrationIdempotencyClaims(testEnv.CATALOGUE_DB)
    .bind(approvalKey, approvalKey)
    .first<{
      claims: number;
      outcomes: number;
      active_ingestion_run_id: string | null;
    }>();
  expect(lifecycle).toEqual({
    claims: 0,
    outcomes: 1,
    active_ingestion_run_id: null,
  });

  const replay = await post(`/v1/ingestion-runs/${run.id}/approval`, approvalRequest);
  expect(replay.response.status).toBe(blocked.response.status);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
  });
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(await publishedCatalogueQueries.readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB).first()).toEqual(
    currentBefore,
  );
  expect(await publishedCatalogueQueries.countCatalogueRevisionsCount(testEnv.CATALOGUE_DB).first()).toEqual(
    revisionsBefore,
  );
});

test("reserved oversized legality relationship recovery preserves the typed terminal problem", async () => {
  const run = await collect(
    "/reconciliation/legality-relationship-over-budget",
    "reconcile-reserved-legality-relationship-over-budget",
    {
      game: "one-piece",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
    },
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(reconciled.document, "expected_current_revision_id");
  const approvalKey = "approve-reserved-legality-relationship-over-budget";
  const revisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvalRequest = {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: approvalKey,
  };
  const approval = {
    action: "approved",
    approved_at: "2026-07-29T02:00:00.000Z",
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      revisionId,
      approval.approved_at,
      "2026-07-29T02:05:00.000Z",
      "a".repeat(64),
      `writer:${revisionId}`,
      run.id,
    )
    .run();
  const currentBefore = await publishedCatalogueQueries
    .readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB)
    .first<{ current_revision_id: string }>();
  const revisionsBefore = await publishedCatalogueQueries
    .countCatalogueRevisionsCount(testEnv.CATALOGUE_DB)
    .first<{ count: number }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort();

  const blocked = await post(`/v1/ingestion-runs/${run.id}/approval`, approvalRequest);
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "catalogue_export_too_large",
  });
  const shown = await get(`/v1/ingestion-runs/${run.id}`);
  expect(shown.document).toMatchObject({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const lifecycle = await ingestionQueries
    .countAdministrationIdempotencyClaimsForReservedOversizedLegalityRelationshipRecoveryPreservesTypedTerminalProblem(
      testEnv.CATALOGUE_DB,
    )
    .bind(approvalKey, approvalKey, run.id, run.id)
    .first<{
      claims: number;
      outcomes: number;
      active_ingestion_run_id: string | null;
      cleanup_state: string;
      cleanup_keys: string;
    }>();
  expect(lifecycle).toEqual({
    claims: 0,
    outcomes: 1,
    active_ingestion_run_id: null,
    cleanup_state: "pending",
    cleanup_keys: "[]",
  });

  const replay = await post(`/v1/ingestion-runs/${run.id}/approval`, approvalRequest);
  expect(replay.response.status).toBe(422);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
  });
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(await publishedCatalogueQueries.readCatalogueStateCurrentRevisionId(testEnv.CATALOGUE_DB).first()).toEqual(
    currentBefore,
  );
  expect(await publishedCatalogueQueries.countCatalogueRevisionsCount(testEnv.CATALOGUE_DB).first()).toEqual(
    revisionsBefore,
  );
});
