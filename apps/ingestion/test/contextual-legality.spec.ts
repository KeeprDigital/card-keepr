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
        id: "cards-and-legality",
        method: "GET",
        url:
          "https://official-source.invalid/reconciliation/contextual-legality-asia",
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
  await waitForState(runId, "parsing");

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
    resulting_revision_id: expect.stringMatching(/^catrev_/),
  });
});

async function waitForState(runId: string, expected: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shown = await request(`/v1/ingestion-runs/${runId}`);
    if (shown.document.state === expected) return;
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
