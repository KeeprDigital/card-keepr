import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { contextualLegalityStatusResponse } from "../../../src/catalogue/legality-status";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("applied D1 request copies reject URL, headers, fingerprint, and deletion drift from immutable Evidence Plans", async () => {
  const runId = "run_operational_plan_immutability";
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'collecting', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`,
    ).bind(runId, "operational-plan-immutability"),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO ingestion_evidence_plans (
         ingestion_run_id, source_lineage, supported_game,
         game_profile_version, adapter_version, request_plan_json,
         plan_origin
       ) VALUES (?, 'one-piece-en', 'one-piece', 'one-piece@1',
         'one-piece-json-document@1', ?, 'production')`,
    ).bind(
      runId,
      JSON.stringify({
        requests: [
          {
            id: "update-target",
            method: "GET",
            url: "https://en.onepiece-cardgame.com/cardlist/",
            headers: { accept: "text/html" },
          },
          {
            id: "delete-target",
            method: "GET",
            url: "https://en.onepiece-cardgame.com/rules/",
            headers: { accept: "text/html" },
          },
        ],
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'update-target', 0, 'GET',
         'https://en.onepiece-cardgame.com/cardlist/',
         '{"accept":"text/html"}', ?, 'pending')`,
    ).bind(runId, "a".repeat(64)),
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'delete-target', 1, 'GET',
         'https://en.onepiece-cardgame.com/rules/',
         '{"accept":"text/html"}', ?, 'pending')`,
    ).bind(runId, "b".repeat(64)),
  ]);

  const updateError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `UPDATE source_requests
       SET url = 'https://attacker.example/changed',
           request_headers_json = '{"accept":"application/json"}',
           representation_fingerprint = ?
       WHERE ingestion_run_id = ? AND request_id = 'update-target'`,
    ).bind("c".repeat(64), runId).run(),
  );
  const deleteError = await rejectedError(
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'delete-target'`,
    ).bind(runId).run(),
  );

  expect([String(updateError), String(deleteError)]).toEqual([
    expect.stringMatching(/source_request_plan_fields_immutable/),
    expect.stringMatching(/source_request_immutable/),
  ]);
});

test.each([
  ["one-piece-json-document@3", "one-piece", "one-piece-en"],
  ["fusion-world-en@2", "fusion-world", "fusion-world-en"],
  ["digimon-en@2", "digimon", "digimon-en"],
  ["gundam-en-asia@2", "gundam", "gundam-en-asia"],
  ["gundam-en-us@2", "gundam", "gundam-en-us"],
])(
  "production planning rejects the undemonstrated %s JSON publisher representation",
  async (adapter, game, lineage) => {
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: game,
      source_lineage: lineage,
      adapter_version: adapter,
      idempotency_key: `reject-undemonstrated-${adapter}`,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url: officialAdapterUrl(adapter, "contextual-legality-asia"),
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
  },
);

test("an unfetched nested image URL cannot enter the official pipeline as byte-proven Printing identity", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "gundam-en-asia@2",
    idempotency_key: "reject-unfetched-image-identity",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-unfetched-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test("every nested Fusion World image candidate is refused until final bytes and authority are captured", async () => {
  const blocked = await request("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@2",
    idempotency_key: "reject-unverified-fusion-world-image-list",
    requests: [
      {
        id: "discovery",
        method: "GET",
        url:
          "https://www.dbs-cardgame.com/fw/en/reconciliation/contextual-legality-secondary-foreign-image",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_not_supported",
  });
});

test.each([
  "copy-count",
  "companion-card",
  "membership-value",
  "rotation-block",
  "release-date",
])(
  "invented JSON cannot claim official wording agrees with a structured %s operand",
  async (operand) => {
    const blocked = await request("/v1/ingestion-runs/evidence", {
      supported_game: "gundam",
      source_lineage: "gundam-en-asia",
      adapter_version: "gundam-en-asia@2",
      idempotency_key: `reject-structured-${operand}`,
      requests: [
        {
          id: "discovery",
          method: "GET",
          url:
            `https://www.gundam-gcg.com/asia-en/reconciliation/contextual-legality-${operand}-operand-mismatch`,
          headers: { accept: "application/json" },
        },
      ],
    });
    expect(blocked.response.status).toBe(422);
    expect(blocked.document).toMatchObject({
      code: "adapter_not_supported",
    });
  },
);

test("test-owned domain evidence publishes exact Legality Rules and keeps still-effective history applicable", async () => {
  const first = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain",
    "contextual-legality-domain-current",
  );
  expect(first.reconciled).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    legality_rules: expect.arrayContaining([
      expect.objectContaining({
        official_id: "legality_rule_asia_copy_limit",
        effect: { type: "copy_limit", maximum_copies: 1 },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_combination",
        effect: expect.objectContaining({
          type: "prohibited_combination",
        }),
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_membership",
        effect: {
          type: "membership",
          attribute: "traits",
          includes_any: ["Earth Federation"],
        },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_rotation",
        effect: { type: "rotation", eligible_blocks: ["1"] },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_release_timing",
        effect: { type: "release_timing", legal_from: "2026-01-01" },
      }),
      expect.objectContaining({
        official_id: "legality_rule_asia_unresolved_scope",
        effect: expect.objectContaining({ type: "unresolved" }),
      }),
    ]),
  });
  const published = await approve(first.reconciled, "publish-current-rules");
  expect(published.response.status).toBe(200);

  const missing = await collectFixtureLegality(
    "https://official-source.invalid/reconciliation/contextual-legality-domain?rules=missing",
    "contextual-legality-domain-missing",
  );
  const missingPublished = await approve(
    missing.reconciled,
    "publish-missing-rules",
  );
  expect(missingPublished.response.status).toBe(200);
  const card = (missing.reconciled.cards as Array<Record<string, unknown>>)
    .find((candidate) =>
      (candidate.official_identity as Record<string, unknown>).value ===
        "GD30-001"
    );
  if (card === undefined) throw new Error("GD30-001 is absent");
  const retainedEligible = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_legality_rules
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.official_id') = ?`,
  )
    .bind(
      requiredString(missingPublished.document, "resulting_revision_id"),
      "legality_rule_asia_eligible",
    )
    .first<{ document_json: string }>();
  const eligible = retainedEligible === null
    ? undefined
    : JSON.parse(retainedEligible.document_json) as Record<string, unknown>;
  expect(eligible).toMatchObject({ current: false });

  const response = await contextualLegalityStatusResponse(
    new Request(
      `https://card-keepr.invalid/v1/legality-status?card_id=${requiredString(card, "id")}&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA`,
    ),
    testEnv.CATALOGUE_DB,
  );
  expect(response.status).toBe(200);
  const status = await response.json() as {
    data: Array<{ status: string; rule_ids: string[] }>;
  };
  expect(status.data[0]).toMatchObject({ status: "legal" });
  expect(status.data[0]!.rule_ids).toContain(requiredString(eligible!, "id"));
});

async function collectFixtureLegality(
  url: string,
  idempotencyKey: string,
): Promise<{
  runId: string;
  reconciled: Record<string, unknown>;
}> {
  const started = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, {
    supported_game: "gundam",
    source_lineage: "gundam-en-asia",
    adapter_version: "fixture-gundam-en-asia-json@1",
    idempotency_key: idempotencyKey,
    requests: [{
      id: "cards-and-rules",
      method: "GET",
      url,
      headers: { accept: "application/json" },
    }],
  });
  const runId = requiredString(started, "id");
  const resumed = await request(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForState(runId, "parsing");
  const reconciled = await request(
    `/v1/ingestion-runs/${runId}/reconciliation`,
    {},
  );
  expect(reconciled.response.status).toBe(200);
  return { runId, reconciled: reconciled.document };
}

function approve(
  reconciled: Record<string, unknown>,
  idempotencyKey: string,
) {
  return request(
    `/v1/ingestion-runs/${requiredString(reconciled, "run_id")}/approval`,
    {
      candidate_digest: requiredString(reconciled, "candidate_digest"),
      expected_current_revision_id: requiredString(
        reconciled,
        "expected_current_revision_id",
      ),
      idempotency_key: idempotencyKey,
    },
  );
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

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}
