import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  catalogueRevisionIdentity,
  catalogueStore,
  canonicalJson,
  rebuildRunProjection,
} from "../../../src/catalogue/shared";
import { fixtureCandidate } from "../../../test/support/catalogue-fixture";
import { seedRunFixtureStatement } from "./query-helpers/run-events";
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

test("historical published and no-change runs rebuild exact administration documents from immutable history", async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const [publishedRunId, unchangedRunId] = await seedHistoricalPublishedRuns();
  const published = await request(`/v1/ingestion-runs/${publishedRunId}`);
  expect(published).toMatchObject({ state: "published", publication_outcome: "revision" });
  const unchanged = await request(`/v1/ingestion-runs/${unchangedRunId}`);
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

async function seedHistoricalPublishedRuns(): Promise<readonly [string, string]> {
  // These synthetic records represent retained history predating route retirement.
  // The established event fixture writes the accepted state path and immutable
  // payload chunks; no new approval, publication, or recovery grant is executed.
  const { candidate, digest } = await fixtureCandidate("first-catalogue", ["one-piece"]);
  const publishedId = "run_historical_published_rebuild";
  const unchangedId = "run_historical_no_change_rebuild";
  const revision = await catalogueRevisionIdentity({
    runId: publishedId,
    candidateDigest: digest,
    expectedCurrentRevisionId: "catrev_spine_000",
  });
  const exported = await buildCatalogueExport(candidate, digest, revision, observedAt);
  for (const [id, predecessor, outcome] of [
    [publishedId, "catrev_spine_000", "revision"],
    [unchangedId, revision, "no_change"],
  ] as const) {
    const approval = {
      action: "approved",
      approved_at: observedAt,
      candidate_digest: digest,
      expected_current_revision_id: predecessor,
    };
    await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
      id,
      state: "published",
      started_at: observedAt,
      terminal_at: observedAt,
      expected_current_revision_id: predecessor,
      linked_run_id: outcome === "no_change" ? publishedId : null,
      selected_games_json: '["one-piece"]',
      candidate_json: canonicalJson(candidate),
      candidate_digest: digest,
      candidate_catalogue_digest: digest,
      candidate_created_at: observedAt,
      approval_deadline: "2026-09-11T00:00:00.000Z",
      approval_json: canonicalJson(approval),
      approval_history_json: canonicalJson([approval]),
      approval_idempotency_key: `${id}-approval`,
      publication_outcome: outcome,
      published_revision_id: outcome === "revision" ? revision : null,
      resulting_revision_id: revision,
      freshness_checked_at: observedAt,
      ...(outcome === "revision"
        ? {
            publication_revision_id: revision,
            publication_started_at: observedAt,
            publication_reconcile_after: "2026-09-04T00:05:00.000Z",
            publication_manifest_digest: exported.manifest.manifest_sha256,
            publication_writer_token: `writer:${revision}`,
            export_manifest_digest: exported.manifest.manifest_sha256,
          }
        : {}),
    }).run();
  }
  return [publishedId, unchangedId];
}
