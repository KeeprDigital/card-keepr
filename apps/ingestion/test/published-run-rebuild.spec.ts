import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore, rebuildRunProjection } from "../../../src/catalogue/shared";
import { injectFixturePublication } from "./fixture-plan-injection";
import * as queries from "./query-helpers/published-run-rebuild";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const observedAt = "2026-09-04T00:00:00.000Z";

async function request(
  path: string,
  body?: Record<string, unknown>,
  expectedStatus = 200,
): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "x-keepr-test-now": observedAt,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const document = await response.json<Record<string, unknown>>();
  expect(response.status, JSON.stringify(document)).toBe(expectedStatus);
  return document;
}

function requiredString(document: Record<string, unknown>, key: string): string {
  const value = document[key];
  if (typeof value !== "string") throw new Error(`Missing ${key}`);
  return value;
}

async function approve(run: Record<string, unknown>, key: string) {
  return request(`/v1/ingestion-runs/${requiredString(run, "id")}/approval`, {
    candidate_digest: requiredString(run, "candidate_digest"),
    expected_current_revision_id: requiredString(run, "expected_current_revision_id"),
    idempotency_key: key,
  });
}

async function administrationSnapshot(runIds: readonly string[]) {
  const shown = await Promise.all(runIds.map((id) => request(`/v1/ingestion-runs/${id}`)));
  const candidates = await Promise.all(
    runIds.map(async (id) => {
      const { request_id, ...problem } = await request(`/v1/ingestion-runs/${id}/candidate`, undefined, 409);
      expect(request_id).toEqual(expect.any(String));
      expect(problem.code).toBe("candidate_not_approvable");
      return problem;
    }),
  );
  const status = await request("/v1/status");
  return { shown, candidates, recentRuns: status.recent_runs };
}

test("published and no-change runs rebuild exact administration documents from immutable history", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const started = await injectFixturePublication(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: "published_rebuild_start",
    },
    observedAt,
  );
  const published = await approve(started, "published_rebuild_approval");
  expect(published).toMatchObject({ state: "published", publication_outcome: "revision" });
  const retry = await request(
    `/v1/ingestion-runs/${requiredString(published, "id")}/retry`,
    {
      idempotency_key: "published_rebuild_retry",
    },
    201,
  );
  const unchanged = await approve(retry, "published_rebuild_no_change");
  expect(unchanged).toMatchObject({
    state: "published",
    publication_outcome: "no_change",
    published_revision_id: null,
    resulting_revision_id: published.resulting_revision_id,
  });
  const runIds = [requiredString(published, "id"), requiredString(unchanged, "id")];
  const before = await administrationSnapshot(runIds);
  const retained = await Promise.all(
    runIds.map(async (id) => ({
      history: (await queries.readPublishedRunHistory(testEnv.CATALOGUE_DB, id).all()).results,
      payloads: (await queries.readPublishedRunPayloads(testEnv.CATALOGUE_DB, id).all()).results,
      projection: await queries.readPublishedRunProjection(testEnv.CATALOGUE_DB, id).first(),
      current: await queries.readPublishedRunCurrent(testEnv.CATALOGUE_DB, id).first(),
    })),
  );
  for (const row of retained) {
    expect(row.history.at(-1)?.event_kind).toBe("published");
    expect(row.history.some((event) => event.event_kind === "approval_reserved")).toBe(true);
    expect(row.payloads.length).toBeGreaterThan(0);
    expect(row.current?.candidate_payload_event_sequence).toBeGreaterThan(0);
    expect(JSON.parse(String(row.projection?.candidate_json)).cards.length).toBeGreaterThan(0);
    expect(JSON.parse(String(row.projection?.approval_history_json))).toHaveLength(1);
  }
  const maintenance = { ownerId: "published_run_rebuild", observedAt };
  const expiresAt = "2099-01-01T00:00:00.000Z";
  expect(
    (await queries.claimPublishedRunRebuild(testEnv.CATALOGUE_DB, maintenance.ownerId, expiresAt).run()).meta.changes,
  ).toBe(1);
  await testEnv.CATALOGUE_DB.batch(
    runIds.flatMap((id) => [
      queries.deletePublishedRunProjection(testEnv.CATALOGUE_DB, id),
      queries.deletePublishedRunGames(testEnv.CATALOGUE_DB, id),
    ]),
  );
  for (const id of runIds) {
    expect(await queries.readPublishedRunProjection(testEnv.CATALOGUE_DB, id).first()).toBeNull();
    await rebuildRunProjection(catalogueStore(testEnv.CATALOGUE_DB), id, maintenance);
    await rebuildRunProjection(catalogueStore(testEnv.CATALOGUE_DB), id, maintenance);
  }
  expect(
    (await queries.releasePublishedRunRebuild(testEnv.CATALOGUE_DB, maintenance.ownerId, expiresAt).run()).meta.changes,
  ).toBe(1);
  expect(await administrationSnapshot(runIds)).toEqual(before);
  for (const [index, id] of runIds.entries()) {
    expect(await queries.readPublishedRunCurrent(testEnv.CATALOGUE_DB, id).first()).toEqual(retained[index]?.current);
    expect((await queries.readPublishedRunHistory(testEnv.CATALOGUE_DB, id).all()).results).toEqual(
      retained[index]?.history,
    );
    expect((await queries.readPublishedRunPayloads(testEnv.CATALOGUE_DB, id).all()).results).toEqual(
      retained[index]?.payloads,
    );
    expect(await queries.readPublishedRunProjection(testEnv.CATALOGUE_DB, id).first()).toEqual(
      retained[index]?.projection,
    );
  }
});
