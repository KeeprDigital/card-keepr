import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  collectSourceRequestBatch,
  pendingEvidenceRequests,
  prepareCaptureAttempt,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  showEvidenceRun,
} from "../../../src/catalogue/source-evidence";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import {
  administrationRequest,
  createCollection,
  installRuntimeSuite,
  waitForEvidenceCondition,
  waitForWorkflowStatus,
} from "./runtime-helpers";
import { acquisitionLegacyFixtureStatements } from "./query-helpers/acquisition-legacy";

installRuntimeSuite();

test("an unstarted legacy run requires explicit prospective initialization without inventing historical usage", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_legacy_unstarted_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  await env.CATALOGUE_DB.batch(acquisitionLegacyFixtureStatements(env.CATALOGUE_DB, runId));
  const requests = await pendingEvidenceRequests(database, runId);
  expect(await showEvidenceRun(database, runId)).toMatchObject({ acquisition: null });
  const resume = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/resume`, "POST");
  expect(resume.status).toBe(409);
  await resume.body?.cancel();
  const intent = {
    expected_generation: 0,
    expected_budget: null,
    acquisition_budget: {
      max_dispatches: 2,
      max_source_bytes: 32 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    idempotency_key: "acquisition_legacy_initialize_001",
  };
  const endpoint = `/v1/ingestion-runs/${runId}/acquisition-budget/extension`;
  const initialized = await administrationRequest(endpoint, "POST", intent);
  expect(initialized.status).toBe(200);
  const receipt = await initialized.json();
  const replay = await administrationRequest(endpoint, "POST", intent);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    id: runId,
    state: "collecting",
    workflow: { parent_id: null },
    acquisition: {
      generation: 1,
      historical_dispatches_unknown: true,
      baseline_source_bytes: 0,
      charged_dispatches: 0,
      charged_source_bytes: 0,
      reserved_source_bytes: 0,
    },
  });
  expect(await pendingEvidenceRequests(database, runId)).toEqual(requests);
  await collectSourceRequestBatch({
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: env.OFFICIAL_SOURCE_TRANSPORT,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests,
  });
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    id: runId,
    acquisition: { charged_dispatches: 1, historical_dispatches_unknown: true },
  });
});

test("paused legacy initialization verifies retained raw keys once and charges a prospective byte baseline", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_legacy_baseline_001",
    requests: [1, 2].map((number) => ({
      id: `request-${number}`,
      url: `https://acquisition-official-source.invalid/sequence/${number}`,
    })),
  });
  const runId = String(created.id);
  const input = {
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: env.OFFICIAL_SOURCE_TRANSPORT,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate" as const,
    pacingIntervalMilliseconds: 0,
    requests: (await pendingEvidenceRequests(database, runId)).slice(0, 1),
  };
  await collectSourceRequestBatch(input);
  const before = await showEvidenceRun(database, runId);
  const snapshots = before.snapshots as Array<{ content: { object_key: string; byte_length: number } }>;
  expect(snapshots).toHaveLength(1);
  const retained = await env.EVIDENCE_OBJECTS.get(snapshots[0]!.content.object_key);
  const baseline = (await retained!.arrayBuffer()).byteLength;
  const pause = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/pause`, "POST", {
    idempotency_key: "legacy_baseline_pause_001",
  });
  expect(pause.status).toBe(200);
  await pause.body?.cancel();
  await env.CATALOGUE_DB.batch(acquisitionLegacyFixtureStatements(env.CATALOGUE_DB, runId));
  const initialized = await administrationRequest(`/v1/ingestion-runs/${runId}/acquisition-budget/extension`, "POST", {
    expected_generation: 0,
    expected_budget: null,
    acquisition_budget: {
      max_dispatches: 2,
      max_source_bytes: 32 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    idempotency_key: "legacy_baseline_initialize_001",
  });
  expect(initialized.status).toBe(200);
  await initialized.body?.cancel();
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    snapshots,
    acquisition: {
      generation: 1,
      historical_dispatches_unknown: true,
      baseline_source_bytes: baseline,
      charged_dispatches: 0,
      charged_source_bytes: baseline,
      reserved_source_bytes: 0,
    },
  });
  await resumePausedEvidenceRun(database, runId);
  await collectSourceRequestBatch({ ...input, requests: await pendingEvidenceRequests(database, runId) });
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    acquisition: { charged_dispatches: 1, baseline_source_bytes: baseline, historical_dispatches_unknown: true },
  });
  expect(await pendingEvidenceRequests(database, runId)).toEqual([]);
});

test("attempting unbudgeted legacy work makes no GET and remains eligible for explicit initialization", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "acquisition_legacy_admission_001",
    requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
  });
  const runId = String(created.id);
  await env.CATALOGUE_DB.batch(acquisitionLegacyFixtureStatements(env.CATALOGUE_DB, runId));
  let calls = 0;
  const requests = await pendingEvidenceRequests(database, runId);
  await collectSourceRequestBatch({
    database,
    evidenceObjects: env.EVIDENCE_OBJECTS,
    officialSourceTransport: {
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        return env.OFFICIAL_SOURCE_TRANSPORT.fetch(url, init);
      },
    } as Fetcher,
    runId,
    hostname: "acquisition-official-source.invalid",
    pacingMode: "immediate",
    pacingIntervalMilliseconds: 0,
    requests,
  });
  expect(calls).toBe(0);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    acquisition: null,
    pause: { reason: "source_acquisition_budget_exhausted", dimension: "policy_missing" },
  });
  const initialized = await administrationRequest(`/v1/ingestion-runs/${runId}/acquisition-budget/extension`, "POST", {
    expected_generation: 0,
    expected_budget: null,
    acquisition_budget: {
      max_dispatches: 2,
      max_source_bytes: 32 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    idempotency_key: "acquisition_legacy_admission_initialize_001",
  });
  expect(initialized.status).toBe(200);
  await initialized.body?.cancel();
  expect(await pendingEvidenceRequests(database, runId)).toEqual(requests);
  expect(await showEvidenceRun(database, runId)).toMatchObject({
    state: "paused",
    acquisition: { charged_dispatches: 0 },
  });
});

test.each(["unfinished", "missing_body", "changed_body", "unreadable_workflow", "terminal"] as const)(
  "legacy initialization rejects %s without inventing an account",
  async (condition) => {
    const database = catalogueStore(env.CATALOGUE_DB);
    const created = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "fixture-one-piece-json@3",
      idempotency_key: `legacy_rejection_${condition}`,
      requests: [{ id: "one", url: "https://acquisition-official-source.invalid/sequence/1" }],
    });
    const runId = String(created.id);
    const requests = await pendingEvidenceRequests(database, runId);
    if (condition === "unfinished") {
      await prepareCaptureAttempt(database, await requiredEvidenceRun(database, runId), requests[0]!);
    } else {
      await collectSourceRequestBatch({
        database,
        evidenceObjects: env.EVIDENCE_OBJECTS,
        officialSourceTransport: env.OFFICIAL_SOURCE_TRANSPORT,
        runId,
        hostname: "acquisition-official-source.invalid",
        pacingMode: "immediate",
        pacingIntervalMilliseconds: 0,
        requests,
      });
    }
    const pause = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/pause`, "POST", {
      idempotency_key: `legacy_rejection_pause_${condition}`,
    });
    expect(pause.status).toBe(200);
    await pause.body?.cancel();
    if (condition === "terminal") {
      const terminated = await administrationRequest(`/v1/ingestion-runs/${runId}/collection/termination`, "POST", {
        idempotency_key: "legacy_rejection_terminate_001",
      });
      expect(terminated.status).toBe(200);
      await terminated.body?.cancel();
    }
    await env.CATALOGUE_DB.batch(acquisitionLegacyFixtureStatements(env.CATALOGUE_DB, runId));
    const before = await showEvidenceRun(database, runId);
    if (condition === "missing_body" || condition === "changed_body") {
      const snapshot = (before.snapshots as Array<{ content: { object_key: string } }>)[0]!;
      if (condition === "missing_body") await env.EVIDENCE_OBJECTS.delete(snapshot.content.object_key);
      else await env.EVIDENCE_OBJECTS.put(snapshot.content.object_key, "unverified replacement");
    }
    const worker = (await import("../src/index")).default;
    const inaccessible = new Proxy(env.EVIDENCE_INGESTION_WORKFLOW, {
      get(target, property) {
        if (property === "get")
          return async () => {
            throw new Error("controlled Workflow status unavailable");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid/v1/ingestion-runs/${runId}/acquisition-budget/extension`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({
          expected_generation: 0,
          expected_budget: null,
          acquisition_budget: {
            max_dispatches: 2,
            max_source_bytes: 32 * 1024 * 1024,
            dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
          },
          idempotency_key: `legacy_rejection_initialize_${condition}`,
        }),
      }),
      condition === "unreadable_workflow" ? { ...env, EVIDENCE_INGESTION_WORKFLOW: inaccessible } : env,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "acquisition_initialization_not_quiescent" });
    expect(await showEvidenceRun(database, runId)).toMatchObject({
      state: before.state,
      acquisition: null,
      snapshots: before.snapshots,
    });
  },
);

test("a retry-paused legacy run with failed attempts is quiescent and initializes prospectively", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  // Four refusals exhaust the first retry generation: every attempt is a
  // positively settled failure and the run rests in a Retry Pause.
  const run = await createCollection(
    "acquisition_legacy_failed_attempts_001",
    "https://acquisition-official-source.invalid/unavailable-then-recovered",
  );
  const started = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(started.status).toBe(202);
  await started.body?.cancel();
  const paused = await waitForEvidenceCondition(run.id, (current) => current.state === "paused", 15_000);
  expect(paused).toMatchObject({ pause: { reason: "source_transport_retries_exhausted" }, snapshots: [] });
  expect(paused.diagnostics.map(({ outcome }) => outcome)).toEqual(Array<string>(4).fill("http_failure"));
  // Quiescence needs the Workflow Attempts themselves to have finished, not
  // only the run row to have paused.
  for (const [binding, id] of [
    [env.EVIDENCE_INGESTION_WORKFLOW, paused.workflow.parent_id],
    ...paused.workflow.child_ids.map((child) => [env.EVIDENCE_HOST_WORKFLOW, child] as const),
  ] as const) {
    if (id === null) throw new Error("missing Workflow identity");
    await waitForWorkflowStatus(id, async () => (await binding.get(id)).status(), "complete", 15_000);
  }
  await env.CATALOGUE_DB.batch(acquisitionLegacyFixtureStatements(env.CATALOGUE_DB, run.id));
  const initialized = await administrationRequest(`/v1/ingestion-runs/${run.id}/acquisition-budget/extension`, "POST", {
    expected_generation: 0,
    expected_budget: null,
    acquisition_budget: {
      max_dispatches: 2,
      max_source_bytes: 32 * 1024 * 1024,
      dispatch_deadline: new Date(Date.now() + 60_000).toISOString(),
    },
    idempotency_key: "legacy_failed_attempts_initialize_001",
  });
  expect([initialized.status, initialized.status === 200 ? "" : await initialized.text()]).toEqual([200, ""]);
  await initialized.body?.cancel();
  expect(await showEvidenceRun(database, run.id)).toMatchObject({
    state: "paused",
    acquisition: {
      generation: 1,
      historical_dispatches_unknown: true,
      baseline_source_bytes: 0,
      charged_dispatches: 0,
      charged_source_bytes: 0,
    },
  });
  const resumed = await administrationRequest(`/v1/ingestion-runs/${run.id}/collection/resume`, "POST");
  expect(resumed.status).toBe(202);
  await resumed.body?.cancel();
  const completed = await waitForEvidenceCondition(
    run.id,
    (current) => current.collection_completed_at !== null,
    15_000,
  );
  expect(completed.snapshots).toHaveLength(1);
  expect(await showEvidenceRun(database, run.id)).toMatchObject({
    acquisition: { charged_dispatches: 1, historical_dispatches_unknown: true },
  });
  expect(await pendingEvidenceRequests(database, run.id)).toEqual([]);
});
