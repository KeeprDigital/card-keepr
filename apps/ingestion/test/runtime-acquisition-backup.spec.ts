import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  showEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";
import { collect, get, requiredString } from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { acquisitionRestoreQueries, resetRestoredAcquisitionDispatchCount } from "./query-helpers/acquisition-restore";
import {
  verifyCompositionSnapshot,
  type CompositionSnapshotEvidence,
} from "../../../src/catalogue/backup-recovery/composition-verification";
import { compositionVerificationQuery } from "../../../src/catalogue/backup-recovery/composition-verification-repository";

installRuntimeSuite();

test("actual SQL restore retains generations, unresolved exposure, pause and the exact source graph and image receipts", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const budget = {
    max_dispatches: 2,
    max_source_bytes: 64 * 1024 * 1024,
    dispatch_deadline: new Date(Date.now() + 120_000).toISOString(),
  };
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "fixture-digimon-json@2",
    idempotency_key: "acquisition_restore_paused_001",
    acquisition_budget: budget,
    requests: [1, 2].map((number) => ({
      id: `request-${number}`,
      url: `https://acquisition-official-source.invalid/sequence/${number}`,
    })),
  });
  const runId = String(created.id);
  const requests = await pendingEvidenceRequests(database, runId);
  const images = await appendDiscoveredEvidenceRequests(
    database,
    await requiredEvidenceRun(database, runId),
    requests[0]!,
    [{ role: "image", url: "https://acquisition-official-source.invalid/image.png", headers: {} }],
  );
  const image = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
    (c) => c.charCodeAt(0),
  );
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) =>
        String(url).endsWith("image.png")
          ? new Response(image, { headers: { "content-type": "image/png" } })
          : env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init),
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: [requests[0]!, images[0]!],
  };
  await collectSourceRequestBatch(input);
  await collectSourceRequestBatch({ ...input, requests: [requests[1]!] });
  const extension = await administrationRequest(`/v1/ingestion-runs/${runId}/acquisition-budget/extension`, "POST", {
    expected_generation: 1,
    expected_budget: budget,
    acquisition_budget: { ...budget, max_dispatches: 3 },
    idempotency_key: "acquisition_restore_extension_001",
  });
  expect(extension.status).toBe(200);
  await extension.body?.cancel();
  await resumePausedEvidenceRun(database, runId);
  let dropped = false;
  const unreliable = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "batch")
        return async (...args: Parameters<D1Database["batch"]>) => {
          const result = await target.batch(...args);
          if (!dropped) {
            dropped = true;
            throw new Error("controlled lost reservation before backup");
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    collectSourceRequestBatch({ ...input, database: catalogueStore(unreliable), requests: [requests[1]!] }),
  ).rejects.toThrow("controlled lost reservation before backup");
  await collectSourceRequestBatch({ ...input, requests: [requests[1]!] });
  const before = await showEvidenceRun(database, runId);
  expect(before).toMatchObject({
    state: "paused",
    pause: { dimension: "ownership" },
    acquisition: { generation: 2, charged_dispatches: 3, reserved_source_bytes: 16 * 1024 * 1024 },
  });
  const snapshots = before.snapshots as Array<{ request: { url: string }; content: { object_key: string } }>;
  expect(snapshots).toHaveLength(2);
  const imageKey = snapshots.find((snapshot) => snapshot.request.url.endsWith("image.png"))!.content.object_key;
  expect(new Uint8Array(await (await env.EVIDENCE_OBJECTS.get(imageKey))!.arrayBuffer())).toEqual(image);

  // A tiny independent publication exercises the shipped backup and actual SQL-import provider.
  const source = await collect("/reconciliation/repeatable", "acquisition_restore_publication_source");
  const candidate = await prepareNativeCandidate(
    source.id,
    "one-piece",
    "catrev_spine_000",
    "acquisition_restore_candidate",
  );
  const published = await approveNativeCandidate(candidate, "acquisition_restore_publication");
  const attemptId = requiredString(published.document, "backup_attempt_id");
  const backup = (await get(`/v1/backups/${attemptId}`)).document;
  expect(backup.state).toBe("verified");
  const sqlObject = await env.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshot = await env.BACKUPS.get(sqlObject!.customMetadata!.snapshot_key!);
  const evidence = await snapshot!.json<CompositionSnapshotEvidence>();
  expect(evidence.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: "ingestion_acquisition_accounts" }),
      expect.objectContaining({ table: "ingestion_acquisition_policies" }),
      expect.objectContaining({ table: "source_dispatch_reservations" }),
      expect.objectContaining({ table: "ingestion_acquisition_pauses" }),
    ]),
  );
  for (const query of acquisitionRestoreQueries(runId)) {
    const expected = (
      await env.CATALOGUE_DB.prepare(query.sql)
        .bind(...query.params)
        .all()
    ).results;
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${backup.disposable_database_id}/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.D1_VERIFICATION_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ sql: query.sql, params: query.params }),
      },
    );
    expect(response.ok).toBe(true);
    const imported = await response.json<{ success: boolean; result: Array<{ results: unknown[] }> }>();
    expect(imported.success).toBe(true);
    expect(imported.result[0]!.results, query.table).toEqual(expected);
  }
  const resume = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(resume.status).toBe(409);
  expect(await resume.json()).toMatchObject({ code: "source_acquisition_ownership_pending" });
  expect((await showEvidenceRun(database, runId)).acquisition).toEqual(before.acquisition);

  for (const statement of resetRestoredAcquisitionDispatchCount(runId)) {
    const reset = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${backup.disposable_database_id}/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.D1_VERIFICATION_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(statement),
      },
    );
    expect(reset.ok, await reset.clone().text()).toBe(true);
    expect(await reset.json()).toMatchObject({ success: true });
  }
  await expect(
    verifyCompositionSnapshot(async (input) => {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${backup.disposable_database_id}/query`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${env.D1_VERIFICATION_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(compositionVerificationQuery(input)),
        },
      );
      const result = await response.json<{ success: boolean; result: Array<{ results: Record<string, unknown>[] }> }>();
      expect(result.success).toBe(true);
      return result.result[0]!.results;
    }, evidence),
  ).rejects.toThrow("Restored composition snapshot differs.");
});
