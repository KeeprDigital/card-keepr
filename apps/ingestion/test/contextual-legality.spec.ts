import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("the production repository ingests effective-dated regional Legality Rules through HTTP", async () => {
  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
    idempotency_key: "contextual-legality-asia",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-asia",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(
    started.response.status,
    JSON.stringify(started.document),
  ).toBe(201);
  const runId = requiredString(started.document, "id");
  expect(runId).toBe(
    "run_95aa67966216ed3cf67871e214d1aa9862b692b42d6a9a537173ad099e260037",
  );
  const resumed = await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  const collected = await waitForState(runId, "parsing");
  expect(collected.snapshots).toHaveLength(4);
  expect(collected.observation_sets).toHaveLength(4);
  expect(collected).toMatchObject({
    evidence_plan: {
      requests: [expect.objectContaining({ id: "discovery" })],
    },
    official_source_collection_plan: {
      contract: "card-keepr-official-source-collection-plan@1",
      content_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      requests: expect.arrayContaining([
        expect.objectContaining({ surface: "legality_card_details" }),
        expect.objectContaining({ surface: "legality_rules" }),
        expect.objectContaining({ surface: "legality_history" }),
      ]),
    },
  });
  const collectionPlan = collected.official_source_collection_plan as {
    requests: { surface: string }[];
  };
  expect(
    collectionPlan.requests.some(
      ({ surface }) =>
        surface === "product_details" || surface === "errata",
    ),
  ).toBe(false);
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE ingestion_evidence_plans
       SET request_plan_json = '{}'
       WHERE ingestion_run_id = ?`,
    )
      .bind(runId)
      .run(),
  ).rejects.toThrow(/ingestion_evidence_plan_request_set_immutable/);
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE official_source_collection_plans
       SET collection_plan_json = '{}'
       WHERE ingestion_run_id = ?`,
    )
      .bind(runId)
      .run(),
  ).rejects.toThrow(/official_source_collection_plan_immutable/);
  expect(
    (collected.snapshots as {
      request: { url: string };
    }[]).every(({ request }) =>
      request.url.startsWith(
        "https://www.gundam-gcg.com/asia-en/",
      ),
    ),
  ).toBe(true);

  const replay = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
    idempotency_key: "contextual-legality-asia",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-asia",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(replay.response.status).toBe(201);
  expect(replay.document).toMatchObject({
    id: runId,
    evidence_plan: collected.evidence_plan,
    official_source_collection_plan:
      collected.official_source_collection_plan,
  });
  const conflictingReplay = await request(
    "/v1/ingestion-runs/evidence",
    {
      supported_game: "gundam",
      source_lineage: "gundam-en-asia",
      adapter_version: "gundam-en-asia@2",
      idempotency_key: "contextual-legality-asia",
      requests: [
        {
          id: "discovery",
          method: "GET",
          url:
            "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-asia?different=true",
          headers: { accept: "application/json" },
        },
      ],
    },
  );
  expect(conflictingReplay.response.status).toBe(409);
  expect(conflictingReplay.document).toMatchObject({
    code: "idempotency_key_reused",
  });

  const reconciled = await request(
    `/v1/ingestion-runs/${runId}/reconciliation`,
    {},
  );
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    legality_rules: expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^legality_rule_[a-f0-9]{64}$/),
        official_id: "legality_rule_asia_copy_limit",
        game: "gundam",
        region: "EN-ASIA",
        format: "standard",
        event_tier: "championship",
        effective_from: "2026-01-01",
        effective_until: null,
        official_wording:
          "For Championship events, decks may contain no more than one copy of GD30-002.",
        effect: { type: "copy_limit", maximum_copies: 1 },
        source_lineage: "gundam-en-asia",
        source_snapshot_id: expect.stringMatching(/^srcsnap_/),
        source_observation_set_id: expect.stringMatching(/^srcobsset_/),
        source_observation_id: expect.stringMatching(/^srcobs_/),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_combination",
        effect: expect.objectContaining({
          type: "prohibited_combination",
        }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_membership",
        effect: expect.objectContaining({ type: "membership" }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_rotation",
        effect: expect.objectContaining({ type: "rotation" }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_release_timing",
        effect: expect.objectContaining({ type: "release_timing" }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_unresolved_scope",
        effect: expect.objectContaining({ type: "unresolved" }),
      }),
    ]),
  });

  const approved = await request(
    `/v1/ingestion-runs/${runId}/approval`,
    {
      candidate_digest: requiredString(
        reconciled.document,
        "candidate_digest",
      ),
      expected_current_revision_id: requiredString(
        reconciled.document,
        "expected_current_revision_id",
      ),
      idempotency_key: "approve-contextual-legality-asia",
    },
  );
  expect(
    approved.response.status,
    JSON.stringify(approved.document),
  ).toBe(200);
  expect(approved.document).toMatchObject({
    state: "published",
    publication_outcome: "revision",
    resulting_revision_id: expect.stringMatching(
      /^catrev_[a-f0-9]{64}$/,
    ),
  });

  const separated = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
    idempotency_key: "contextual-legality-asia-separated",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-asia",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(separated.response.status).toBe(201);
  expect(requiredString(separated.document, "id")).toBe(
    "run_929268c9a227c6a0032d6c24fbe2bd649954725e19275319b86d297475a65e32",
  );
  expect(requiredString(separated.document, "id")).not.toBe(runId);
  const released = await testEnv.CATALOGUE_DB.prepare(
    `UPDATE operation_state
     SET active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?`,
  )
    .bind(requiredString(separated.document, "id"))
    .run();
  expect(released.meta.changes).toBe(1);
});

test.each([
  {
    adapter: "one-piece-json-document@3",
    game: "one-piece",
    lineage: "one-piece-en",
    scenario: "contextual-legality-empty-one-piece",
  },
  {
    adapter: "fusion-world-en@2",
    game: "fusion-world",
    lineage: "fusion-world-en",
    scenario: "contextual-legality-empty-oceania",
  },
  {
    adapter: "digimon-en@2",
    game: "digimon",
    lineage: "digimon-en",
    scenario: "contextual-legality-empty-oceania",
  },
  {
    adapter: "gundam-en-asia@2",
    game: "gundam",
    lineage: "gundam-en-asia",
    scenario: "contextual-legality-empty-asia",
  },
  {
    adapter: "gundam-en-us@2",
    game: "gundam",
    lineage: "gundam-en-us",
    scenario: "contextual-legality-empty-us",
  },
])(
  "$adapter accepts an explicitly complete empty legality partition through HTTP",
  async ({ adapter, game, lineage, scenario }) => {
    const runId = await startAdapterCollection({
      adapter,
      game,
      lineage,
      scenario,
    });
    const parsing = await waitForState(runId, "parsing");
    expect(parsing).toMatchObject({
      id: runId,
      state: "parsing",
    });
    expect(
      Array.isArray(parsing.observation_sets)
        ? parsing.observation_sets.length
        : 0,
    ).toBeGreaterThanOrEqual(
      adapter === "one-piece-json-document@3" ? 7 : 4,
    );
    const reconciled = await request(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      {},
    );
    expect(
      reconciled.response.status,
      JSON.stringify(reconciled.document),
    ).toBe(200);
    expect(reconciled.document).toMatchObject({
      state: "awaiting_approval",
      publishable: true,
      cards: [],
      legality_rules: [],
    });
    // The parameterized cases share one test D1 instance. Release only the
    // test runner's global lock after the public reconciliation assertion so
    // each registered adapter can exercise the same boundary independently.
    const released = await testEnv.CATALOGUE_DB.prepare(
      `UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE singleton = 1 AND active_ingestion_run_id = ?`,
    )
      .bind(runId)
      .run();
    expect(released.meta.changes).toBe(1);
  },
);

test.each([
  ["contextual-legality-missing-rules"],
  ["contextual-legality-false-empty-rules"],
  ["contextual-legality-incomplete-discovery"],
  ["contextual-legality-unknown-rule-wording"],
  ["contextual-legality-mismatched-rule-wording"],
  ["contextual-legality-foreign-image-authority"],
])(
  "the production adapter fails closed for %s through HTTP",
  async (scenario) => {
    const runId = await startAdapterCollection({
      adapter: "gundam-en-asia@2",
      game: "gundam",
      lineage: "gundam-en-asia",
      scenario,
    });
    const failed = await waitForState(runId, "failed");
    expect(failed).toMatchObject({
      id: runId,
      state: "failed",
      failure_code: "source_parse_failed",
    });
  },
);

test("a complete adapter rejects an arbitrary HTTPS discovery authority before creating a run", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
    idempotency_key: "contextual-legality-arbitrary-authority",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://attacker.example/asia-en/reconciliation/contextual-legality-asia",
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "invalid_parameter",
  });
});

async function startAdapterCollection({
  adapter,
  game,
  lineage,
  scenario,
}: {
  adapter: string;
  game: string;
  lineage: string;
  scenario: string;
}): Promise<string> {
  const idempotencyKey =
    `contextual-legality-adapter-${adapter}-${scenario}`;
  const started = await request("/v1/ingestion-runs/evidence", {
    supported_game: game,
    source_lineage: lineage,
    adapter_version: adapter,
    idempotency_key: idempotencyKey,
    requests: [
      {
        id: "discovery",
        method: "GET",
        url: officialAdapterUrl(adapter, scenario),
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  const resumed = await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  return runId;
}

function officialAdapterUrl(adapter: string, scenario: string): string {
  if (adapter === "one-piece-json-document@3") {
    return `https://en.onepiece-cardgame.com/reconciliation/${scenario}`;
  }
  if (adapter === "fusion-world-en@2") {
    return `https://www.dbs-cardgame.com/fw/en/reconciliation/${scenario}`;
  }
  if (adapter === "digimon-en@2") {
    return `https://world.digimoncard.com/reconciliation/${scenario}`;
  }
  if (adapter === "gundam-en-asia@2") {
    return `https://www.gundam-gcg.com/asia-en/reconciliation/${scenario}`;
  }
  return `https://www.gundam-gcg.com/en/reconciliation/${scenario}`;
}

async function waitForState(runId: string, expected: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const shown = await request(`/v1/ingestion-runs/${runId}`);
    if (shown.document.state === expected) return shown.document;
    if (shown.document.state === "failed") {
      throw new Error(JSON.stringify(shown.document));
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} did not reach ${expected}`);
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

function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}
