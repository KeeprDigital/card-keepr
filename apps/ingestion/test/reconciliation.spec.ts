import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
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
  const existingCard = await testEnv.CATALOGUE_DB.prepare(
    "SELECT first_revision_id, withdrawn FROM reconciled_cards WHERE id = ?",
  )
    .bind(cardId)
    .first<{ first_revision_id: string; withdrawn: number }>();
  const existingPrinting = await testEnv.CATALOGUE_DB.prepare(
    "SELECT first_revision_id, withdrawn FROM reconciled_printings WHERE id = ?",
  )
    .bind(printingId)
    .first<{ first_revision_id: string; withdrawn: number }>();
  const catalogueExport = await buildCatalogueExport(
    candidate,
    digest,
    revisionId,
    approvedAt,
    {
      cards: {
        [cardId]: {
          first_revision_id:
            existingCard?.first_revision_id ?? revisionId,
          last_observed_revision_id: revisionId,
          withdrawn: existingCard?.withdrawn === 1,
        },
      },
      printings: {
        [printingId]: {
          first_revision_id:
            existingPrinting?.first_revision_id ?? revisionId,
          last_observed_revision_id: revisionId,
          withdrawn: existingPrinting?.withdrawn === 1,
        },
      },
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
    adapter: "fusion-world-en@1",
    scenario: "profile-fusion-world",
    profile: "fusion-world@1",
    identity: "FB01-001",
    printingCount: 1,
  },
  {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "digimon-en@1",
    scenario: "profile-digimon",
    profile: "digimon@1",
    identity: "BT1-001",
    printingCount: 1,
  },
  {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "gundam-en-asia@1",
    scenario: "profile-gundam",
    profile: "gundam@1",
    identity: "GD01-001",
    printingCount: 1,
  },
  {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "one-piece-json-document@1",
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

test("an unresolved canonical Card fact conflict hard-fails instead of replacing current truth", async () => {
  const firstRun = await collect(
    "/reconciliation/canonical-base",
    "reconcile-canonical-base",
  );
  const first = await reconcile(firstRun.id);
  await approve(first.document);

  const changedRun = await collect(
    "/reconciliation/canonical-name-conflict",
    "reconcile-canonical-name-conflict",
  );
  const changed = await reconcile(changedRun.id);
  expect(changed.response.status).toBe(409);
  expect(changed.document).toMatchObject({
    diagnostics: [
      {
        code: "canonical_card_conflict",
        detail: expect.stringContaining("deterministic authority"),
      },
    ],
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
    adapter_version: source?.adapter ?? "one-piece-json-document@1",
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
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    if (shown.document.state === "parsing") {
      return { id, document: shown.document };
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${id} did not reach parsing`);
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
