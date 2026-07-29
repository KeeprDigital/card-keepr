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
      expect.objectContaining({ official_code: "product_op01" }),
      expect.objectContaining({ official_code: "product_promotion" }),
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
  ).toEqual([
    expect.objectContaining({
      id: expect.stringMatching(/^distribution_context_[a-f0-9]{64}$/),
      label: "context_event",
    }),
  ]);
  expect(
    JSON.stringify(
      await exportComponentRecords(secondRevision, "relationships"),
    ),
  ).not.toContain("source_bucket");
  const publishedPrinting = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`,
  )
    .bind(secondRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  const publishedPrintingDocument = JSON.parse(
    publishedPrinting?.document_json ?? "{}",
  ) as Record<string, unknown>;
  expect(publishedPrintingDocument).toMatchObject({
    distribution_contexts: [
      {
        id: expect.stringMatching(/^distribution_context_[a-f0-9]{64}$/),
        kind: "other",
        label: "context_event",
        product_id: null,
        evidence_category: "explicit",
      },
    ],
    relationship_evidence: expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });
  expect(publishedPrintingDocument.relationship_evidence).toEqual(
    lifecycle.document.relationship_evidence,
  );

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
          assertion: "withdrawn",
          effective: true,
          evidence: "Official withdrawal notice",
          source_lineage: "one-piece-en",
          source_snapshot_id: expect.stringMatching(/^srcsnap_/),
          source_observation_set_id: expect.stringMatching(/^srcobsset_/),
          source_observation_id: expect.stringMatching(/^srcobs_/),
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
            assertion: "withdrawn",
            effective: true,
            evidence: "Official withdrawal notice",
            source_lineage: "one-piece-en",
            source_snapshot_id: expect.stringMatching(/^srcsnap_/),
            source_observation_set_id: expect.stringMatching(/^srcobsset_/),
            source_observation_id: expect.stringMatching(/^srcobs_/),
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
    approvedAt,
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
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
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
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@1",
    idempotency_key: "reconcile-production-adapter-without-coverage",
    requests: [
      {
        id: "cards",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/profile-fusion-world",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const run = {
    id: requiredString(started.document, "id"),
  };
  const resumed = await post(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForRunState(run.id, "parsing");
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

test("the production source-plan route rejects synthetic fixture adapters without creating provenance", async () => {
  const blocked = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "production-route-fixture-bypass",
    requests: [
      {
        id: "cards",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_origin_not_permitted",
  });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM ingestion_evidence_plans AS plan
     JOIN ingestion_runs AS run ON run.id = plan.ingestion_run_id
     WHERE run.idempotency_key = 'production-route-fixture-bypass'`,
  ).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("the test-only fixture route compares its secret without accepting prefix or length variants", async () => {
  for (const attemptedKey of [
    "vitest-fixture-source-plan-ke",
    "vitest-fixture-source-plan-key!",
    "vitest-fixture-source-plan-kex",
  ]) {
    const blocked = await request(
      "/v1/internal/fixture-ingestion-runs/evidence",
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@1",
        idempotency_key: `fixture-secret-${attemptedKey.length}-${attemptedKey.at(-1)}`,
        requests: [],
      },
      {
        "x-card-keepr-fixture-source-plan-key": attemptedKey,
      },
    );
    expect(blocked.response.status).toBe(404);
    expect(blocked.document).toMatchObject({ code: "route_not_found" });
  }
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
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
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

test("functional DON!! identity rejects a non-don Card shape even when Printing evidence exists", async () => {
  const run = await collect(
    "/reconciliation/profile-don-invalid-printing",
    "reconcile-invalid-don-printing",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "functional DON!! identity requires",
        ),
      },
    ],
  });
});

test("numbered One Piece identities cannot claim the functional DON card type", async () => {
  const run = await collect(
    "/reconciliation/profile-numbered-don-invalid",
    "reconcile-invalid-numbered-don",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "card_type don requires functional DON!! identity",
        ),
      },
    ],
  });
});

test("official numbered identities canonicalize permitted case and reject whitespace or malformed variants", async () => {
  const lowerRun = await collect(
    "/reconciliation/identity-lower",
    "reconcile-identity-lower",
  );
  const lower = await reconcile(lowerRun.id);
  expect(lower.response.status).toBe(200);
  const cardId = requiredString(requiredFirst(lower.document, "cards"), "id");
  expect(requiredFirst(lower.document, "cards")).toMatchObject({
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(lower.document);

  const upperRun = await collect(
    "/reconciliation/identity-upper",
    "reconcile-identity-upper",
  );
  const upper = await reconcile(upperRun.id);
  expect(upper.response.status).toBe(200);
  expect(requiredFirst(upper.document, "cards")).toMatchObject({
    id: cardId,
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(upper.document);

  for (const scenario of ["identity-whitespace", "identity-malformed"]) {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `reconcile-${scenario}`,
    );
    const blocked = await reconcile(run.id);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      diagnostics: [
        {
          code: "retained_evidence_invalid",
          detail: expect.stringContaining("official card number"),
        },
      ],
    });
  }
});

test("conflicting explicit withdrawal assertions fail during reconciliation with stable diagnostics", async () => {
  const run = await collect(
    "/reconciliation/withdrawal-conflict",
    "reconcile-withdrawal-conflict",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "withdrawal_evidence_conflict",
        detail: expect.stringContaining("withdrawal assertions conflict"),
      }),
    ],
  });
});

test("withdrawal assertions are longitudinal, append-only, and preserve the first transition", async () => {
  const firstRun = await collect(
    "/reconciliation/withdrawn-longitudinal",
    "reconcile-withdrawal-longitudinal-first",
  );
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const firstRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const printingId = requiredString(
    requiredFirst(first.document, "printings"),
    "id",
  );

  const repeatRun = await collect(
    "/reconciliation/withdrawn-longitudinal",
    "reconcile-withdrawal-longitudinal-repeat",
  );
  const repeat = await reconcile(repeatRun.id);
  expect(repeat.response.status).toBe(200);
  expect(repeat.document.candidate_digest).toBe(
    first.document.candidate_digest,
  );
  const repeated = await approve(repeat.document);
  expect(repeated.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: firstRevision,
  });
  const retained = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(retained.document).toMatchObject({
    lifecycle: {
      withdrawn: true,
      withdrawal: { revision_id: firstRevision },
    },
  });
  const history = await testEnv.CATALOGUE_DB.prepare(
    `SELECT evidence_json
     FROM reconciled_withdrawal_assertions
     WHERE entity_type = 'printing' AND entity_id = ?
     ORDER BY source_observation_id`,
  )
    .bind(printingId)
    .all<{ evidence_json: string }>();
  expect(history.results).toHaveLength(2);

  const conflictRun = await collect(
    "/reconciliation/withdrawn-conflicting-later",
    "reconcile-withdrawal-longitudinal-conflict",
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [
      expect.objectContaining({ code: "withdrawal_evidence_conflict" }),
    ],
  });
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
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
        current: true,
      }),
    ]),
  );

  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "reconcile-gundam-cross-us-whole-printing-omitted",
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
  expect(inspected.document.diff).toMatchObject({
    printings: {
      missing_observations: [printingId],
    },
  });
  const usMissingPublished = await approve(usMissing.document);
  const usMissingRevision = requiredString(
    usMissingPublished.document,
    "resulting_revision_id",
  );
  const omittedCardObservation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current, last_missing_revision_id
     FROM reconciled_card_observations
     WHERE card_id = ? AND source_lineage = 'gundam-en-us'
     ORDER BY catalogue_revision_id DESC
     LIMIT 1`,
  )
    .bind(requiredString(requiredFirst(us.document, "cards"), "id"))
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedCardObservation).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const omittedPrintingLocator = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current, last_missing_revision_id
     FROM reconciled_printing_locators
     WHERE printing_id = ? AND source_lineage = 'gundam-en-us'`,
  )
    .bind(printingId)
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedPrintingLocator).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const isolated = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(isolated.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
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

  for (const [scenario, key] of [
    [
      "gundam-cross-product-conflict",
      "reconcile-gundam-product-conflict",
    ],
    [
      "gundam-cross-variant-conflict",
      "reconcile-gundam-variant-conflict",
    ],
  ] as const) {
    const mismatchRun = await collect(
      `/reconciliation/${scenario}`,
      key,
      {
        game: "gundam",
        lineage: "gundam-en-us",
        adapter: "fixture-gundam-en-us-json@1",
      },
    );
    const mismatch = await reconcile(mismatchRun.id);
    expect(mismatch.response.status).toBe(409);
    expect(mismatch.document).toMatchObject({
      diagnostics: [
        {
          code: "printing_match_contradictory",
          candidate_printing_ids: [printingId],
        },
      ],
    });
  }
}, 20_000);

test("Gundam EN-ASIA canonical facts win independent of source run order", async () => {
  const usRun = await collect(
    "/reconciliation/gundam-authority-us",
    "reconcile-gundam-authority-us-first",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  await approve(us.document);

  const asiaRun = await collect(
    "/reconciliation/gundam-authority-asia",
    "reconcile-gundam-authority-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  expect(asia.response.status).toBe(200);
  expect(requiredFirst(asia.document, "cards")).toMatchObject({
    id: requiredString(requiredFirst(us.document, "cards"), "id"),
    name: "Authoritative Asia name",
  });
  await approve(asia.document);

  const conflictRun = await collect(
    "/reconciliation/gundam-authority-us-conflict",
    "reconcile-gundam-authority-us-conflict",
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
      expect.objectContaining({ code: "canonical_card_conflict" }),
    ],
  });
});

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

test("reversing retained observation order preserves the candidate digest and relationship result", async () => {
  const forwardRun = await collect(
    "/reconciliation/deterministic-forward",
    "reconcile-deterministic-forward",
  );
  const forward = await reconcile(forwardRun.id);
  const published = await approve(forward.document);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );

  const reverseRun = await collect(
    "/reconciliation/deterministic-reverse",
    "reconcile-deterministic-reverse",
  );
  const reverse = await reconcile(reverseRun.id);
  expect(reverse.document.candidate_digest).toBe(
    forward.document.candidate_digest,
  );
  const repeated = await approve(reverse.document);
  expect(repeated.document).toMatchObject({
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
  const onePieceRevision = requiredString(
    onePiecePublished.document,
    "resulting_revision_id",
  );
  const firstManifest = await exportManifest(onePieceRevision);

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
  const secondManifest = await exportManifest(revisionId);
  expect(secondManifest.source_freshness).toEqual(
    expect.arrayContaining([
      {
        game: "one-piece",
        area: "cards-and-printings",
        checked_at: firstManifest.source_freshness.find(
          ({ game }) => game === "one-piece",
        )?.checked_at,
      },
      {
        game: "fusion-world",
        area: "cards-and-printings",
        checked_at: secondManifest.published_at,
      },
    ]),
  );
  const products = await exportComponentRecords(revisionId, "products");
  const sharedProducts = products.filter(
    (product) =>
      product.official_code === "product_op01" &&
      ["one-piece", "fusion-world"].includes(String(product.game)),
  );
  expect(sharedProducts).toHaveLength(2);
  expect(new Set(sharedProducts.map(({ id }) => id)).size).toBe(2);
  expect(sharedProducts.map(({ game }) => game).sort()).toEqual([
    "fusion-world",
    "one-piece",
  ]);
  const relationships = await exportComponentRecords(
    revisionId,
    "relationships",
  );
  expect(relationships.every(({ id }) =>
    /^relationship_[a-f0-9]{64}$/.test(String(id)),
  )).toBe(true);
  const sharedProductIds = new Set(sharedProducts.map(({ id }) => id));
  const productTargets = relationships
    .filter(
      ({ relationship_value, to }) =>
        relationship_value === "product_op01" &&
        sharedProductIds.has((to as Record<string, unknown>).id),
    )
    .map(({ to }) => (to as Record<string, unknown>).id);
  expect(new Set(productTargets).size).toBe(2);
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
        code: "relationship_not_observed",
        printing_id: requiredString(firstPrinting, "id"),
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
  const intervening = await post("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "intervening-current-revision",
  });
  expect(intervening.response.status).toBe(201);
  const interveningPublished = await post(
    `/v1/ingestion-runs/${requiredString(intervening.document, "id")}/approval`,
    {
      candidate_digest: requiredString(
        intervening.document,
        "candidate_digest",
      ),
      expected_current_revision_id: requiredString(
        intervening.document,
        "expected_current_revision_id",
      ),
      idempotency_key: "approve-intervening-current-revision",
    },
  );
  expect(interveningPublished.response.status).toBe(200);
  const currentRevision = requiredString(
    interveningPublished.document,
    "resulting_revision_id",
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
    plan_origin: "synthetic_fixture",
    expected_current_revision_id: currentRevision,
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
  const blockedMutation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ingestion_runs
        WHERE idempotency_key = 'blocked-recovery-start') AS runs,
       active_ingestion_run_id
     FROM operation_state
     WHERE singleton = 1`,
  ).first<{ runs: number; active_ingestion_run_id: string | null }>();
  expect(blockedMutation).toEqual({
    runs: 0,
    active_ingestion_run_id: null,
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
  const started = await postFixtureEvidence({
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

function postFixtureEvidence(body: Record<string, unknown>) {
  return request(
    "/v1/internal/fixture-ingestion-runs/evidence",
    body,
    {
      "x-card-keepr-fixture-source-plan-key":
        "vitest-fixture-source-plan-key",
    },
  );
}

async function request(
  pathname: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
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
        ...extraHeaders,
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

async function exportManifest(revisionId: string): Promise<{
  published_at: string;
  source_freshness: {
    game: string;
    area: string;
    checked_at: string;
  }[];
}> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  if (manifestObject === null) throw new Error("export manifest missing");
  return manifestObject.json();
}
