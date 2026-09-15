import document from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

test("retained reconciliation commands reject nonnumeric generation before looking up retained state", async () => {
  for (const generation of ["01", null, [1], -1, 1.5]) {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/ingestion-runs/run_missing/reconciliation/pause", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({ generation, idempotency_key: "pause" }),
      }),
      testEnv,
    );
    expect(response.status, JSON.stringify(generation)).toBe(422);
    await assertHttpResponse(document, "/v1/ingestion-runs/{run}/reconciliation/pause", "post", response);
    expect(await response.json()).toMatchObject({ code: "invalid_parameter" });
  }
});

test.each([false, true])(
  "historical candidate inspection verifies its retained bytes before returning a diff (corrupt=%s)",
  async (corrupt) => {
    const { fixtureCandidate } = await import("../../../test/support/catalogue-fixture");
    const { canonicalJson, sha256Text } = await import("../../../src/catalogue/shared");
    const { seedRunFixtureStatement } = await import("./query-helpers/run-events");
    const candidate = (await fixtureCandidate("first-catalogue", ["one-piece"])).candidate;
    const retained = {
      ...candidate,
      cards: candidate.cards.map(
        ({ category: _category, gameplay_applicability: _applicability, related_cards: _relationships, ...card }) =>
          card,
      ),
      printings: candidate.printings.map(({ gameplay_applicability: _applicability, ...printing }) => printing),
    };
    const originalBytes = canonicalJson(retained);
    const bytes = corrupt ? originalBytes.replace("Monkey.D.Luffy", "Corrupt Luffy") : originalBytes;
    const created = new Date().toISOString();
    const deadline = new Date(Date.parse(created) + 604800000).toISOString();
    const digest = await sha256Text(originalBytes);
    const run = `run_obsolete_inspection_${corrupt}`;
    await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
      id: run,
      state: "awaiting_approval",
      selected_games_json: '["one-piece"]',
      idempotency_key: run,
      started_at: created,
      expected_current_revision_id: "catrev_spine_000",
      candidate_json: bytes,
      candidate_digest: digest,
      candidate_created_at: created,
      approval_deadline: deadline,
    }).run();
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run}/candidate`, {
        headers: { authorization: "Bearer vitest-administration-key" },
      }),
      testEnv,
    );
    expect(response.status).toBe(corrupt ? 500 : 200);
    await assertHttpResponse(document, "/v1/ingestion-runs/{run}/candidate", "get", response);
    if (!corrupt)
      expect(await response.json()).toMatchObject({
        run_id: run,
        candidate_digest: digest,
        diff: { summary: { cards_added: 1 } },
      });
  },
);
