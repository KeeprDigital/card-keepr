import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

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
      products: ["product_op01", "product_promotion"],
      distribution_contexts: ["context_event"],
      source_buckets: ["main-list", "promotion-list"],
    },
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
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

async function collect(path: string, key: string): Promise<{
  id: string;
  document: Record<string, unknown>;
}> {
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-json-document@1",
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
