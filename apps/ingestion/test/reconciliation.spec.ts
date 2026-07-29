import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { reconciliationPublication } from "../../../src/catalogue/reconciliation-publication";
import type { FixtureCandidate } from "../../../src/catalogue/fixture";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("retained immutable evidence publishes stable identities and warns when earlier membership disappears", async () => {
  const firstRun = await collect("/reconciliation/base", "reconcile-base");
  const first = await reconcile(firstRun.id);
  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-printing-reconciliation@2",
    state: "awaiting_approval",
    publishable: true,
    warnings: [],
  });
  const firstCard = requiredFirst(first.document, "cards");
  const firstPrinting = requiredFirst(first.document, "printings");
  expect(firstCard.id).toMatch(/^card_[a-f0-9]{32}$/);
  expect(firstPrinting.id).toMatch(/^printing_[a-f0-9]{32}$/);
  const firstPublished = await approve(first.document);
  expect(firstPublished.response.status).toBe(200);
  const firstRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );

  const secondRun = await collect(
    "/reconciliation/new-locator",
    "reconcile-new-locator",
  );
  const second = await reconcile(secondRun.id);
  expect(second.response.status).toBe(200);
  expect(requiredFirst(second.document, "cards").id).toBe(firstCard.id);
  expect(requiredFirst(second.document, "printings").id).toBe(
    firstPrinting.id,
  );
  expect(second.document).toMatchObject({
    warnings: [
      {
        code: "relationship_not_observed",
        relationship_kind: "product",
        relationship_value: "product_op01",
        printing_id: firstPrinting.id,
      },
      {
        code: "relationship_not_observed",
        relationship_kind: "source_bucket",
        relationship_value: "main-list",
        printing_id: firstPrinting.id,
      },
    ],
  });
  const secondPublished = await approve(second.document);
  expect(secondPublished.response.status).toBe(200);
  const secondRevision = requiredString(
    secondPublished.document,
    "resulting_revision_id",
  );

  const lifecycle = await get(
    `/v1/reconciliation/printings/${firstPrinting.id}`,
  );
  expect(lifecycle.response.status).toBe(200);
  expect(lifecycle.document).toMatchObject({
    id: firstPrinting.id,
    card_id: firstCard.id,
    locators: ["/official/base", "/official/renamed"],
    memberships: {
      current: {
        products: ["product_promotion"],
        distribution_contexts: ["context_event"],
        source_buckets: ["promotion-list"],
      },
      historical: {
        products: [
          expect.objectContaining({
            id: "product_op01",
            first_revision_id: firstRevision,
            last_observed_revision_id: firstRevision,
            current: false,
            last_missing_revision_id: secondRevision,
          }),
        ],
        source_buckets: [
          expect.objectContaining({
            id: "main-list",
            first_revision_id: firstRevision,
            last_observed_revision_id: firstRevision,
            current: false,
            last_missing_revision_id: secondRevision,
          }),
        ],
      },
    },
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
    relationship_evidence: expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_kind: "product",
        relationship_value: "product_promotion",
        current: true,
        source_observation_ids: expect.arrayContaining([
          expect.stringMatching(/^srcobs_/),
        ]),
      }),
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_kind: "product",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });
  expect(
    await exportComponentRecords(secondRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: secondRevision,
        withdrawn: false,
      },
    }),
  );
  expect(
    await exportComponentRecords(secondRevision, "products"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "product_op01" }),
      expect.objectContaining({ id: "product_promotion" }),
    ]),
  );
  expect(
    await exportComponentRecords(secondRevision, "relationships"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_op01",
        lifecycle: expect.objectContaining({ current: false }),
      }),
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_promotion",
        lifecycle: expect.objectContaining({ current: true }),
      }),
    ]),
  );
  expect(
    await exportComponentRecords(
      secondRevision,
      "distribution-contexts",
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "promotion-list" }),
      expect.objectContaining({ id: "main-list" }),
    ]),
  );
  const publishedPrinting = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`,
  )
    .bind(secondRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  expect(JSON.parse(publishedPrinting?.document_json ?? "{}")).toMatchObject({
    relationship_evidence: expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });

  const withdrawalRun = await collect(
    "/reconciliation/withdrawn",
    "reconcile-withdrawn",
  );
  const withdrawal = await reconcile(withdrawalRun.id);
  expect(withdrawal.response.status).toBe(200);
  const withdrawalPublished = await approve(withdrawal.document);
  const withdrawalRevision = requiredString(
    withdrawalPublished.document,
    "resulting_revision_id",
  );
  const withdrawn = await get(
    `/v1/reconciliation/printings/${firstPrinting.id}`,
  );
  expect(withdrawn.document).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: withdrawalRevision,
      withdrawn: true,
      withdrawal: {
        revision_id: withdrawalRevision,
        evidence: {
          entity: "printing",
          evidence: "Official withdrawal notice",
        },
      },
    },
  });

  const exported = await exportComponentRecords(
    withdrawalRevision,
    "printings",
  );
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: withdrawalRevision,
        withdrawn: true,
        withdrawal: {
          revision_id: withdrawalRevision,
          evidence: {
            entity: "printing",
            evidence: "Official withdrawal notice",
          },
        },
      },
    }),
  );
  const revisionDocument = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`,
  )
    .bind(withdrawalRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  expect(
    JSON.parse(revisionDocument?.document_json ?? "{}"),
  ).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: withdrawalRevision,
      withdrawn: true,
    },
  });
});

test("an interrupted reconciliation publication recovers the exact digest-bound candidate and export", async () => {
  const run = await collect(
    "/reconciliation/base",
    "reconcile-interrupted",
  );
  const reconciled = await reconcile(run.id);
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(
    reconciled.document,
    "expected_current_revision_id",
  );
  const persisted = await testEnv.CATALOGUE_DB.prepare(
    "SELECT candidate_json FROM ingestion_runs WHERE id = ?",
  )
    .bind(run.id)
    .first<{ candidate_json: string }>();
  const candidate = JSON.parse(
    persisted?.candidate_json ?? "{}",
  ) as FixtureCandidate;
  const revisionId = "catrev_reconciliation_interrupted";
  const approvedAt = "2026-07-29T02:00:00.000Z";
  const reconcileAfter = "2026-07-29T02:05:00.000Z";
  const approvalKey = "approve-reconciliation-interrupted";
  const cardId = candidate.cards[0]!.id;
  const printingId = candidate.printings[0]!.id;
  const publication = await reconciliationPublication(
    testEnv.CATALOGUE_DB,
    run.id,
    revisionId,
  );
  if (publication === null) throw new Error("publication plan missing");
  const catalogueExport = await buildCatalogueExport(
    candidate,
    digest,
    revisionId,
    approvedAt,
    {
      cards: publication.cardLifecycles,
      printings: publication.printingLifecycles,
      relationships: publication.relationshipEvidence,
    },
  );
  const approval = {
    action: "approved",
    approved_at: approvedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'publishing',
         approval_json = ?,
         approval_idempotency_key = ?,
         approval_history_json = ?,
         progress_json = ?,
         publication_revision_id = ?,
         publication_started_at = ?,
         publication_reconcile_after = ?,
         publication_manifest_digest = ?,
         publication_writer_token = ?
     WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
        current_stage: "publishing",
      }),
      revisionId,
      approvedAt,
      reconcileAfter,
      catalogueExport.manifest.manifest_sha256,
      `writer:${revisionId}`,
      run.id,
    )
    .run();
  for (const object of catalogueExport.objects) {
    await testEnv.CATALOGUE_EXPORTS.put(object.key, object.bytes);
  }

  const recovered = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    {
      candidate_digest: digest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: approvalKey,
    },
  );
  if (recovered.response.status !== 200) {
    throw new Error(JSON.stringify(recovered.document));
  }
  expect({
    status: recovered.response.status,
    document: recovered.document,
  }).toMatchObject({ status: 200 });
  expect(recovered.document).toMatchObject({
    state: "published",
    resulting_revision_id: revisionId,
    export_manifest_digest: catalogueExport.manifest.manifest_sha256,
  });
});

test("a complete zero-match blocks publication unless retained evidence proves a demonstrably novel appearance", async () => {
  const run = await collect(
    "/reconciliation/not-demonstrably-novel",
    "reconcile-not-novel",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        source_observation_id: expect.stringMatching(/^srcobs_/),
      },
    ],
  });
  const approval = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    {
      candidate_digest: "a".repeat(64),
      expected_current_revision_id: "catrev_spine_000",
      idempotency_key: "blocked-approval",
    },
  );
  expect(approval.response.status).toBe(409);
  expect(approval.document).toMatchObject({
    code: "run_not_awaiting_approval",
  });
});

test("a novel flag without structurally complete adapter and Printing Image evidence blocks publication", async () => {
  const run = await collect(
    "/reconciliation/incomplete-appearance",
    "reconcile-incomplete-appearance",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        detail: expect.stringContaining("structurally complete"),
      },
    ],
  });
});

test("immutable Observation Set counts, not an observation novelty assertion, decide structural completeness", async () => {
  const run = await collect(
    "/reconciliation/set-count-mismatch",
    "reconcile-set-count-mismatch",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "Source Observation Set provenance is invalid",
        ),
      },
    ],
  });
});

test("unknown controlled vocabulary remains retained evidence, warns, and stays out of the Game Profile", async () => {
  const run = await collect(
    "/reconciliation/unknown-vocabulary",
    "reconcile-unknown-vocabulary",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const warnings = reconciled.document.warnings;
  expect(Array.isArray(warnings) ? warnings : []).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_vocabulary",
      profile: "one-piece@1",
      path: "printing.illustration_types",
      raw_value: "etched-future",
    }),
  );
  expect(Array.isArray(warnings) ? warnings : []).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_field",
      path: "new_official_label",
      raw_value: "Bandai-added-value",
    }),
  );
  expect(
    requiredFirst(reconciled.document, "printings"),
  ).toMatchObject({
    game_data: {
      profile: "one-piece@1",
      attributes: { illustration_types: [] },
    },
  });
  const observationSetId = requiredString(
    requiredFirst(run.document, "observation_sets"),
    "id",
  );
  const retained = await get(
    `/v1/source-observation-sets/${observationSetId}/content`,
  );
  expect(retained.response.status).toBe(200);
  expect(JSON.stringify(retained.document)).toContain("etched-future");
  const rejected = await post(
    `/v1/ingestion-runs/${run.id}/rejection`,
    {
      candidate_digest: requiredString(
        reconciled.document,
        "candidate_digest",
      ),
      idempotency_key: "reject-unknown-vocabulary",
    },
  );
  expect(rejected.response.status).toBe(200);
});

test.each([
  {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@1",
    scenario: "profile-fusion-world",
    profile: "fusion-world@1",
    identity: "FB01-001",
    printingCount: 1,
  },
  {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "fixture-digimon-json@1",
    scenario: "profile-digimon",
    profile: "digimon@1",
    identity: "BT1-001",
    printingCount: 1,
  },
  {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@1",
    scenario: "profile-gundam",
    profile: "gundam@1",
    identity: "GD01-001",
    printingCount: 1,
  },
  {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@1",
    scenario: "profile-don",
    profile: "one-piece@1",
    identity: "DON!!",
    printingCount: 0,
  },
])(
  "publishes accepted $profile identity without one-printing assumptions",
  async ({
    game,
    lineage,
    adapter,
    scenario,
    profile,
    identity,
    printingCount,
  }) => {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `reconcile-${scenario}`,
      { game, lineage, adapter },
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const card = requiredFirst(reconciled.document, "cards");
    expect(card).toMatchObject({
      game,
      official_identity: {
        kind:
          identity === "DON!!"
            ? "functional_designation"
            : "card_number",
        value: identity,
      },
      game_data: { profile },
    });
    expect(
      Array.isArray(reconciled.document.printings)
        ? reconciled.document.printings
        : [],
    ).toHaveLength(printingCount);
    const published = await approve(reconciled.document);
    if (published.response.status !== 200) {
      throw new Error(JSON.stringify(published.document));
    }
    expect(published.response.status).toBe(200);
  },
);

test("production adapter placeholders fail closed without adapter-owned coverage proof", async () => {
  const run = await collect(
    "/reconciliation/profile-fusion-world",
    "reconcile-production-adapter-without-coverage",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fusion-world-en@1",
    },
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "Source Observation Set provenance is invalid",
        ),
      },
    ],
  });
});

test("one complete retained set can publish multiple Printings without collapsing their identities", async () => {
  const run = await collect(
    "/reconciliation/multi-printing",
    "reconcile-multi-printing",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(2);
  const printingIds = (
    reconciled.document.printings as Record<string, unknown>[]
  ).map((printing) => printing.id);
  expect(new Set(printingIds).size).toBe(2);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("the profile registry strips and warns on unknown nested fields while enforcing exact numeric types", async () => {
  const warningRun = await collect(
    "/reconciliation/profile-nested-unknown",
    "reconcile-profile-nested-unknown",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const warned = await reconcile(warningRun.id);
  expect(warned.response.status).toBe(200);
  expect(warned.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.specified_cost[0].new_metric",
        raw_value: "retained raw",
      }),
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.skills[0].new_label",
        raw_value: "retained raw",
      }),
    ]),
  );
  expect(JSON.stringify(requiredFirst(warned.document, "cards"))).not.toContain(
    "new_metric",
  );
  await post(`/v1/ingestion-runs/${warningRun.id}/rejection`, {
    candidate_digest: requiredString(warned.document, "candidate_digest"),
    idempotency_key: "reject-nested-profile-warning",
  });

  const invalidRun = await collect(
    "/reconciliation/profile-invalid-number",
    "reconcile-profile-invalid-number",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const invalid = await reconcile(invalidRun.id);
  expect(invalid.response.status).toBe(409);
  expect(invalid.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("card.cost"),
      },
    ],
  });
});

test("a structurally complete non-DON Card may have zero catalogued Printings", async () => {
  const run = await collect(
    "/reconciliation/card-without-printing",
    "reconcile-card-without-printing",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toEqual([]);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("DON!! accepts explicit known Printing evidence while retaining incomplete-coverage warning semantics", async () => {
  const run = await collect(
    "/reconciliation/profile-don-printing",
    "reconcile-don-known-printing",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(1);
  expect(reconciled.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_coverage_incomplete",
        card_id: requiredString(
          requiredFirst(reconciled.document, "cards"),
          "id",
        ),
      }),
    ]),
  );
  await approve(reconciled.document);
});

test("Gundam EN-ASIA and EN-US evidence converges on one Printing while substantive conflict blocks", async () => {
  const asiaRun = await collect(
    "/reconciliation/gundam-cross-asia",
    "reconcile-gundam-cross-asia",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  const printingId = requiredString(
    requiredFirst(asia.document, "printings"),
    "id",
  );
  await approve(asia.document);

  const usRun = await collect(
    "/reconciliation/gundam-cross-us",
    "reconcile-gundam-cross-us",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  expect(requiredFirst(us.document, "printings")).toMatchObject({
    id: printingId,
  });
  await approve(us.document);
  const lifecycle = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(lifecycle.document.locators).toEqual([
    "/official/gundam/gundam-cross-asia",
    "/official/gundam/gundam-cross-us",
  ]);
  expect(lifecycle.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_asia",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_us",
        current: true,
      }),
    ]),
  );

  const usMissingRun = await collect(
    "/reconciliation/gundam-cross-us-empty",
    "reconcile-gundam-cross-us-empty",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const usMissing = await reconcile(usMissingRun.id);
  const inspected = await get(
    `/v1/ingestion-runs/${usMissingRun.id}/candidate`,
  );
  const warningJson = JSON.stringify(inspected.document.diff);
  expect(warningJson).toContain("product_us");
  expect(warningJson).not.toContain("product_asia");
  await approve(usMissing.document);
  const isolated = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(isolated.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_asia",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_us",
        current: false,
      }),
    ]),
  );

  const cardConflictRun = await collect(
    "/reconciliation/gundam-card-conflict",
    "reconcile-gundam-card-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const cardConflict = await reconcile(cardConflictRun.id);
  expect(cardConflict.response.status).toBe(409);
  expect(cardConflict.document).toMatchObject({
    diagnostics: [
      {
        code: "canonical_card_conflict",
        detail: expect.stringContaining("source lineages"),
      },
    ],
  });

  const conflictRun = await collect(
    "/reconciliation/gundam-cross-conflict",
    "reconcile-gundam-cross-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [
      {
        code: "printing_match_contradictory",
        candidate_printing_ids: [printingId],
      },
    ],
  });
}, 20_000);

test("repeated semantically identical retained evidence keeps one candidate digest and records no change", async () => {
  const firstRun = await collect(
    "/reconciliation/repeatable",
    "reconcile-repeatable-first",
  );
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const revisionId = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );

  const secondRun = await collect(
    "/reconciliation/repeatable",
    "reconcile-repeatable-second",
  );
  const second = await reconcile(secondRun.id);
  expect(second.document.candidate_digest).toBe(
    first.document.candidate_digest,
  );
  const secondPublished = await approve(second.document);
  expect(secondPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
});

test("a known locator with contradictory retained material evidence fails the run before publication", async () => {
  const establishedRun = await collect(
    "/reconciliation/conflict-base",
    "reconcile-conflict-base",
  );
  const established = await reconcile(establishedRun.id);
  expect(established.response.status).toBe(200);
  await approve(established.document);

  const conflictRun = await collect(
    "/reconciliation/conflict-changed",
    "reconcile-conflict-changed",
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      {
        code: "printing_match_contradictory",
        locator: "/official/conflict",
      },
    ],
  });
});

test("same-lineage authoritative Card evolution updates canonical facts while preserving identity", async () => {
  const firstRun = await collect(
    "/reconciliation/canonical-base",
    "reconcile-canonical-base",
  );
  const first = await reconcile(firstRun.id);
  const cardId = requiredString(requiredFirst(first.document, "cards"), "id");
  await approve(first.document);

  const changedRun = await collect(
    "/reconciliation/canonical-name-conflict",
    "reconcile-canonical-name-conflict",
  );
  const changed = await reconcile(changedRun.id);
  expect(changed.response.status).toBe(200);
  expect(requiredFirst(changed.document, "cards")).toMatchObject({
    id: cardId,
    name: "Unsupported replacement name",
  });
  await approve(changed.document);
  const history = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_lineage, canonical_facts_json, current
     FROM reconciled_card_observations
     WHERE card_id = ?
     ORDER BY catalogue_revision_id`,
  )
    .bind(cardId)
    .all<{
      source_lineage: string;
      canonical_facts_json: string;
      current: number;
    }>();
  expect(history.results).toHaveLength(2);
  expect(history.results.map(({ current }) => current).sort()).toEqual([0, 1]);
});

test("sequential selected-game publications retain the complete current catalogue across D1 and export", async () => {
  const onePieceRun = await collect(
    "/reconciliation/base",
    "reconcile-union-one-piece",
  );
  const onePiece = await reconcile(onePieceRun.id);
  const onePieceCard = requiredFirst(onePiece.document, "cards");
  const onePiecePrinting = requiredFirst(onePiece.document, "printings");
  const onePiecePublished = await approve(onePiece.document);
  expect(onePiecePublished.response.status).toBe(200);

  const fusionRun = await collect(
    "/reconciliation/union-fusion-world",
    "reconcile-union-fusion-world",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const fusion = await reconcile(fusionRun.id);
  expect(fusion.response.status).toBe(200);
  const candidate = await get(
    `/v1/ingestion-runs/${fusionRun.id}/candidate`,
  );
  expect(candidate.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 1,
        printings_added: 1,
      },
    },
  });
  const published = await approve(fusion.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const profiles = await exportComponentRecords(
    revisionId,
    "game-profiles",
  );
  expect(profiles).toContainEqual(
    expect.objectContaining({
      profile: "fusion-world@1",
      schema: expect.objectContaining({
        additionalProperties: false,
        required: ["card", "printing"],
        properties: expect.objectContaining({
          card: expect.objectContaining({
            additionalProperties: false,
            required: expect.arrayContaining([
              "card_type",
              "specified_cost",
            ]),
          }),
        }),
      }),
    }),
  );

  const d1Cards = await testEnv.CATALOGUE_DB.prepare(
    "SELECT card_id FROM revision_cards WHERE catalogue_revision_id = ? ORDER BY card_id",
  )
    .bind(revisionId)
    .all<{ card_id: string }>();
  expect(d1Cards.results.length).toBeGreaterThanOrEqual(2);
  expect(d1Cards.results.map(({ card_id }) => card_id)).toContain(
    requiredString(onePieceCard, "id"),
  );
  const d1Printings = await testEnv.CATALOGUE_DB.prepare(
    "SELECT printing_id FROM revision_printings WHERE catalogue_revision_id = ? ORDER BY printing_id",
  )
    .bind(revisionId)
    .all<{ printing_id: string }>();
  expect(d1Printings.results.map(({ printing_id }) => printing_id)).toContain(
    requiredString(onePiecePrinting, "id"),
  );
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(
    d1Cards.results.length,
  );
});

test("candidate inspection reports stable reconciliation matches rather than every entity as added", async () => {
  const firstRun = await collect(
    "/reconciliation/base",
    "reconcile-inspection-base",
  );
  const first = await reconcile(firstRun.id);
  const firstCard = requiredFirst(first.document, "cards");
  const firstPrinting = requiredFirst(first.document, "printings");
  await approve(first.document);

  const nextRun = await collect(
    "/reconciliation/new-locator",
    "reconcile-inspection-new-locator",
  );
  const next = await reconcile(nextRun.id);
  const inspected = await get(
    `/v1/ingestion-runs/${nextRun.id}/candidate`,
  );
  expect(inspected.response.status).toBe(200);
  const inspectedWarnings = (
    inspected.document.diff as Record<string, unknown>
  ).warnings as Record<string, unknown>[];
  expect(inspectedWarnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "record_not_observed",
        card_id: expect.any(String),
      }),
      expect.objectContaining({
        code: "record_not_observed",
        printing_id: expect.any(String),
      }),
    ]),
  );
  expect(inspected.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 0,
        printings_added: 0,
      },
      cards: {
        added: [],
        changed: [],
        missing_observations: expect.not.arrayContaining([
          requiredString(firstCard, "id"),
        ]),
      },
      printings: {
        added: [],
        changed: [],
        identity_matches: [requiredString(firstPrinting, "id")],
      },
    },
  });
  await post(`/v1/ingestion-runs/${nextRun.id}/rejection`, {
    candidate_digest: requiredString(next.document, "candidate_digest"),
    idempotency_key: "reject-inspected-candidate",
  });
});

test("generic retry rejects an evidence-backed terminal run so reconciliation provenance cannot be reset", async () => {
  const run = await collect(
    "/reconciliation/base",
    "reconcile-generic-retry",
  );
  const reconciled = await reconcile(run.id);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(
      reconciled.document,
      "candidate_digest",
    ),
    idempotency_key: "reject-before-generic-retry",
  });

  const retried = await post(`/v1/ingestion-runs/${run.id}/retry`, {
    idempotency_key: "generic-retry-must-not-reset-evidence",
  });
  expect(retried.response.status).toBe(409);
  expect(retried.document).toMatchObject({
    code: "evidence_retry_required",
  });
  const original = await get(`/v1/ingestion-runs/${run.id}`);
  expect(original.document).toMatchObject({
    state: "rejected",
  });
  const retainedCandidate = await testEnv.CATALOGUE_DB.prepare(
    `SELECT candidate.candidate_digest, plan.digest_payload_json
     FROM ingestion_runs AS candidate
     JOIN reconciliation_candidates AS plan
       ON plan.ingestion_run_id = candidate.id
     WHERE candidate.id = ?
     LIMIT 1`,
  )
    .bind(run.id)
    .first<{
      candidate_digest: string;
      digest_payload_json: string;
    }>();
  expect(retainedCandidate).toMatchObject({
    candidate_digest: requiredString(
      reconciled.document,
      "candidate_digest",
    ),
  });
  expect(retainedCandidate?.digest_payload_json).toContain(
    '"catalogue_data"',
  );
  const evidenceRetry = await post(
    `/v1/ingestion-runs/${run.id}/collection/retry`,
    { idempotency_key: "linked-retry-retains-evidence-plan" },
  );
  expect(evidenceRetry.response.status).toBe(201);
  expect(evidenceRetry.document).toMatchObject({
    state: "collecting",
    linked_run_id: run.id,
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
  });
  const retryId = requiredString(evidenceRetry.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${retryId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForRunState(retryId, "parsing");
  const retryCandidate = await reconcile(retryId);
  const rejected = await post(`/v1/ingestion-runs/${retryId}/rejection`, {
    candidate_digest: requiredString(
      retryCandidate.document,
      "candidate_digest",
    ),
    idempotency_key: "reject-linked-retry-after-verification",
  });
  expect(rejected.response.status).toBe(200);
}, 15_000);

test("recovery health gates evidence start and reconciliation before mutation", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedStart = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-json-document@1",
    idempotency_key: "blocked-recovery-start",
    requests: [
      {
        id: "cards",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blockedStart.response.status).toBe(409);
  expect(blockedStart.document).toMatchObject({
    code: "recovery_not_verified",
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const run = await collect(
    "/reconciliation/base",
    "blocked-recovery-reconciliation",
  );
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedReconciliation = await reconcile(run.id);
  expect(blockedReconciliation.response.status).toBe(409);
  expect(blockedReconciliation.document).toMatchObject({
    code: "recovery_not_verified",
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const resumed = await reconcile(run.id);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(resumed.document, "candidate_digest"),
    idempotency_key: "reject-after-recovery-restored",
  });
});

async function collect(
  path: string,
  key: string,
  source?: { game: string; lineage: string; adapter: string },
): Promise<{
  id: string;
  document: Record<string, unknown>;
}> {
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: source?.game ?? "one-piece",
    source_lineage: source?.lineage ?? "one-piece-en",
    adapter_version: source?.adapter ?? "fixture-one-piece-json@1",
    idempotency_key: key,
    requests: [
      {
        id: "cards",
        method: "GET",
        url: `https://official-source.invalid${path}`,
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  const document = await waitForRunState(id, "parsing");
  return { id, document };
}

async function waitForRunState(
  id: string,
  expectedState: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    if (shown.document.state === expectedState) {
      return shown.document;
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not reach ${expectedState}`);
}

function reconcile(runId: string) {
  return post(`/v1/ingestion-runs/${runId}/reconciliation`, {});
}

function approve(document: Record<string, unknown>) {
  return post(
    `/v1/ingestion-runs/${requiredString(document, "run_id")}/approval`,
    {
      candidate_digest: requiredString(document, "candidate_digest"),
      expected_current_revision_id: requiredString(
        document,
        "expected_current_revision_id",
      ),
      idempotency_key: `approve-${crypto.randomUUID()}`,
    },
  );
}

function get(pathname: string) {
  return request(pathname);
}

function post(pathname: string, body: Record<string, unknown>) {
  return request(pathname, body);
}

async function request(
  pathname: string,
  body?: Record<string, unknown>,
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(requestSequence++ % 250) + 1}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return {
    response,
    document: (await response.json()) as Record<string, unknown>,
  };
}

function requiredFirst(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const values = document[field];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} is empty`);
  }
  const value = values[0];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}[0] is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

async function exportComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  const manifest = await manifestObject?.json<{
    components: {
      name: string;
      compressed_sha256: string;
    }[];
  }>();
  const component = manifest?.components.find(
    (candidate) => candidate.name === componentName,
  );
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component?.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("export component missing");
  const decompressed = object.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const text = await new Response(decompressed).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
