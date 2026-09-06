import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { sourceFreshnessFromStorage } from "../../../src/catalogue/read";
import {
  parseReconciliationObservation,
  type ReconciliationWorkflowParams,
  reconcileRetainedCardPrintingEvidence,
  reconciliationPublication,
  startOrObserveReconciliationWorkflow,
} from "../../../src/catalogue/reconciliation";
import { type CatalogueCandidate, catalogueRevisionIdentity, catalogueStore } from "../../../src/catalogue/shared";
import ingestionWorker from "../src/index";
import { runReconciliationWorkflow } from "../src/reconciliation-workflow";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import * as ingestionQueries from "./query-helpers/ingestion";
import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import * as reconciliationQueries from "./query-helpers/reconciliation";
import {
  approve,
  collect,
  collectRequests,
  exportComponentRecords,
  get,
  installReconciliationSuite,
  post,
  reconcile,
  requiredFirst,
  requiredRecord,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

// A candidate expires seven days after the instant it was reconciled at, so an
// approval decision taken on the wall clock stops reaching a reconciliation
// pinned to a fixed calendar date once that week elapses. Scenarios that pin
// the reconciliation instant take their decision on the same clock.
const reconciledAt = "2026-07-31T01:00:00.000Z";

test("stored Source freshness rejects removed eligibility areas", () => {
  expect(() =>
    sourceFreshnessFromStorage({
      game: "gundam",
      area: "legality-rules",
      source_lineage: "",
      region: "",
      checked_at: "2026-08-02T00:00:00.000Z",
    }),
  ).toThrow(/freshness scope is invalid/);
});

test("retained Gundam Official Errata crosses the reconciliation boundary", () => {
  expect(() =>
    parseReconciliationObservation("srcobs_gundam_erratum", {
      kind: "official_erratum",
      game: "gundam",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: "GD04-067" },
      },
      published_on: "2026-04-10",
      effective_from: null,
      observed_printed_rules_text: "from your trash.",
      corrected_rules_text: "from any player's trash.",
      official_wording: "Before: from your trash.\nAfter: from any player's trash.",
      applies_to_parallel_printings: true,
      source: {
        fragment: "#gundam-02_157-gd04-067",
        display_name: "GD04-067",
        image_url: "https://www.gundam-gcg.com/gcg/bccard/en/news/2026/04/GD04-067.webp",
      },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    }),
  ).not.toThrow();
});

test("reconciliation is Workflow-owned and exact replays observe one bound instance", async () => {
  const run = await collect("/reconciliation/base", "workflow-owned-reconciliation");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  const requestBody = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "workflow-owned-reconciliation-request",
  };
  const first = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, requestBody);
  expect(first.response.status).toBe(202);
  expect(first.document).toMatchObject({
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: requestBody.idempotency_key,
    workflow_instance_id: expect.any(String),
  });

  const replay = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, requestBody);
  expect(replay.response.status).toBe(200);
  expect(replay.document.workflow_instance_id).toBe(first.document.workflow_instance_id);

  const conflicting = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: "catrev_conflicting_request",
    idempotency_key: requestBody.idempotency_key,
  });
  expect(conflicting.response.status).toBe(409);
  expect(conflicting.document).toMatchObject({
    code: "idempotency_conflict",
  });

  const stale = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: "catrev_stale_request",
    idempotency_key: "workflow-owned-reconciliation-stale",
  });
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({
    code: "current_revision_mismatch",
  });

  let completed = replay;
  const deadline = Date.now() + 15_000;
  while (completed.document.status !== "complete") {
    if (Date.now() >= deadline) {
      throw new Error(`reconciliation Workflow ${run.id} did not complete`);
    }
    completed = await post(`/v1/ingestion-runs/${run.id}/reconciliation`, requestBody);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const output = requiredRecord(completed.document.output, "output");
  expect(output).toMatchObject({
    run_id: run.id,
    publishable: true,
  });
  const rejected = await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(output, "candidate_digest"),
    idempotency_key: "reject-workflow-owned-reconciliation",
  });
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({
    id: run.id,
    state: "rejected",
  });
  const terminalStatus = await get("/v1/status");
  expect(requiredRecord(terminalStatus.document.safe_state, "safe_state")).toMatchObject({
    active_ingestion_run_id: null,
  });
});

test("a Workflow that terminalizes during initial HTTP creation returns 200", async () => {
  const run = await collect("/reconciliation/base", "workflow-terminal-on-http-create");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  let instanceStatus: Awaited<ReturnType<WorkflowInstance["status"]>> = {
    status: "running",
  };
  const instance = {
    status: async () => instanceStatus,
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => {
      const retained = await reconcileRetainedCardPrintingEvidence(
        catalogueStore(testEnv.CATALOGUE_DB),
        testEnv.EVIDENCE_OBJECTS,
        run.id,
        "2026-07-31T01:00:00.000Z",
        testEnv.PRINTING_IMAGES,
      );
      instanceStatus = {
        status: "complete",
        output: {
          result_json: JSON.stringify({
            contract: "card-keepr-reconciliation-workflow-result@1",
            run_id: run.id,
            candidate_digest: requiredString(retained, "candidate_digest"),
          }),
        },
      };
      return instance;
    },
    get: async () => instance,
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const terminalEnv = Object.create(testEnv) as Env;
  Object.defineProperty(terminalEnv, "RECONCILIATION_WORKFLOW", {
    value: workflow,
  });
  const response = await ingestionWorker.fetch(
    new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation`, {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": "203.0.113.250",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-07-31T01:00:00.000Z",
      },
      body: JSON.stringify({
        expected_current_revision_id: expectedCurrentRevisionId,
        idempotency_key: "workflow-terminal-on-http-create-request",
      }),
    }),
    terminalEnv,
  );
  expect(response.status).toBe(200);
  const document = await response.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    status: "complete",
    output: {
      run_id: run.id,
      candidate_digest: expect.any(String),
    },
  });
  const output = requiredRecord(document.output, "output");
  expect(
    (
      await post(
        `/v1/ingestion-runs/${run.id}/rejection`,
        {
          candidate_digest: requiredString(output, "candidate_digest"),
          idempotency_key: "reject-workflow-terminal-on-http-create",
        },
        { "x-keepr-test-now": reconciledAt },
      )
    ).response.status,
  ).toBe(200);
});

test("an exact reconciliation replay observes without creating or executing the bound Workflow again", async () => {
  const run = await collect("/reconciliation/base", "observe-only-workflow-replay");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  const createIds: string[] = [];
  const getIds: string[] = [];
  let durableOutput: { result_json: string } | null = null;
  let instanceExists = false;
  const instance = {
    status: async () =>
      durableOutput === null ? { status: "running" } : { status: "complete", output: durableOutput },
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async ({ id }: { id: string }) => {
      createIds.push(id);
      if (createIds.length > 1) {
        throw new Error("duplicate Workflow execution");
      }
      instanceExists = true;
      const result = await reconcileRetainedCardPrintingEvidence(
        catalogueStore(testEnv.CATALOGUE_DB),
        testEnv.EVIDENCE_OBJECTS,
        run.id,
        "2026-07-31T01:00:00.000Z",
        testEnv.PRINTING_IMAGES,
      );
      durableOutput = {
        result_json: JSON.stringify({
          contract: "card-keepr-reconciliation-workflow-result@1",
          run_id: run.id,
          candidate_digest: requiredString(result, "candidate_digest"),
        }),
      };
      return instance;
    },
    get: async (id: string) => {
      getIds.push(id);
      return instanceExists
        ? instance
        : ({
            status: async () => ({ status: "unknown" }),
          } as unknown as WorkflowInstance);
    },
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const input = {
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "observe-only-workflow-replay-request",
  };
  const first = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  const replay = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T01:01:00.000Z",
  );

  expect(first.created).toBe(true);
  expect(replay.created).toBe(false);
  expect(replay.document.workflow_instance_id).toBe(first.document.workflow_instance_id);
  expect(createIds).toEqual([first.document.workflow_instance_id]);
  expect(getIds).toEqual([first.document.workflow_instance_id]);
  await expect(
    reconciliationQueries
      .countReconciliationWorkflowRequestsCount(testEnv.CATALOGUE_DB)
      .bind(run.id)
      .first<{ count: number }>(),
  ).resolves.toMatchObject({ count: 1 });
  const output = requiredRecord(replay.document.output, "output");
  const rejected = await post(
    `/v1/ingestion-runs/${run.id}/rejection`,
    {
      candidate_digest: requiredString(output, "candidate_digest"),
      idempotency_key: "reject-observe-only-workflow-replay",
    },
    { "x-keepr-test-now": reconciledAt },
  );
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({
    id: run.id,
    state: "rejected",
  });
  const terminalStatus = await get("/v1/status");
  expect(requiredRecord(terminalStatus.document.safe_state, "safe_state")).toMatchObject({
    active_ingestion_run_id: null,
  });
});

test("an exact reconciliation replay recreates a deterministically bound instance after create loss", async () => {
  const run = await collect("/reconciliation/base", "workflow-create-loss-recovery");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  const createParams: ReconciliationWorkflowParams[] = [];
  let instanceExists = false;
  const instance = {
    status: async () => ({ status: "running" }),
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async (input: { id: string; params: ReconciliationWorkflowParams }) => {
      createParams.push(input.params);
      if (createParams.length === 1) {
        throw new Error("injected create response loss");
      }
      instanceExists = true;
      return instance;
    },
    get: async () => {
      if (!instanceExists) throw new Error("instance not found");
      return instance;
    },
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const input = {
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "workflow-create-loss-recovery-request",
  };

  await expect(
    startOrObserveReconciliationWorkflow(
      catalogueStore(testEnv.CATALOGUE_DB),
      workflow,
      input,
      "2026-07-31T01:00:00.000Z",
    ),
    // Dispatch failed and no instance was observed: retain the dispatch failure,
    // rather than recategorizing this control-plane outage as a lost identity.
  ).rejects.toThrow("injected create response loss");
  const replay = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T02:00:00.000Z",
  );

  expect(replay.created).toBe(false);
  expect(createParams).toEqual([
    {
      ...input,
      observed_at: "2026-07-31T01:00:00.000Z",
    },
    {
      ...input,
      observed_at: "2026-07-31T01:00:00.000Z",
    },
  ]);
  const stored = await reconciliationQueries
    .readReconciliationWorkflowRequestsWorkflowParamsJson(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{ workflow_params_json: string }>();
  expect(JSON.parse(stored?.workflow_params_json ?? "null")).toEqual(createParams[0]);
  const reconciled = await reconcileRetainedCardPrintingEvidence(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.EVIDENCE_OBJECTS,
    run.id,
    "2026-07-31T01:00:00.000Z",
    testEnv.PRINTING_IMAGES,
  );
  expect(
    (
      await post(
        `/v1/ingestion-runs/${run.id}/rejection`,
        {
          candidate_digest: requiredString(reconciled, "candidate_digest"),
          idempotency_key: "reject-workflow-create-loss-recovery",
        },
        { "x-keepr-test-now": reconciledAt },
      )
    ).response.status,
  ).toBe(200);
});

test("reconciliation commit success survives lost step output without repeating semantic work", async () => {
  const operationalRecords: string[] = [];
  vi.spyOn(console, "info").mockImplementation((value) => {
    operationalRecords.push(String(value));
  });
  const run = await collect("/reconciliation/base", "workflow-output-loss-recovery");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  let reconciliationAttempts = 0;
  const step = {
    do: async (name: string, _config: unknown, callback: (context: unknown) => Promise<string>) => {
      if (name === "reconcile retained Card, Printing, and Erratum evidence") {
        reconciliationAttempts += 1;
        await callback({ step: { name, count: 2 }, attempt: 3 });
        reconciliationAttempts += 1;
      }
      return callback({ step: { name, count: 2 }, attempt: 3 });
    },
  } as unknown as WorkflowStep;
  const output = await runReconciliationWorkflow(
    testEnv,
    {
      instanceId: "workflow-reconciliation-correlation",
      workflowName: "reconciliation-workflow",
      timestamp: new Date("2026-07-31T01:00:00.000Z"),
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: expectedCurrentRevisionId,
        idempotency_key: "workflow-output-loss-recovery-request",
        observed_at: "2026-07-31T01:00:00.000Z",
      },
    } as WorkflowEvent<ReconciliationWorkflowParams>,
    step,
  );

  expect(reconciliationAttempts).toBe(2);
  const workflowRecord = operationalRecords
    .map((record) => JSON.parse(record))
    .find(
      (record) =>
        record.event === "workflow.step.completed" && record.request?.id === "workflow-reconciliation-correlation",
    );
  expect(workflowRecord).toMatchObject({
    contract: "card-keepr-operational-log@1",
    runtime: "ingestion",
    request: {
      id: "workflow-reconciliation-correlation",
      method: "WORKFLOW",
      route: "/workflows/reconciliation-workflow",
    },
    status: 200,
    workflow: {
      step: "reconcile retained Card, Printing, and Erratum evidence",
      step_count: 2,
    },
    retry: { count: 2, classification: "not_applicable" },
    cache: { status: "unknown" },
    d1: { prepared_statements: expect.any(Number) },
  });
  expect(workflowRecord.duration_ms).toEqual(expect.any(Number));
  expect(JSON.parse(output.result_json)).toMatchObject({
    contract: "card-keepr-reconciliation-workflow-result@1",
    run_id: run.id,
    candidate_digest: expect.any(String),
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({
    state: "awaiting_approval",
  });
  const durable = JSON.parse(output.result_json) as Record<string, unknown>;
  expect(
    (
      await post(
        `/v1/ingestion-runs/${run.id}/rejection`,
        {
          candidate_digest: requiredString(durable, "candidate_digest"),
          idempotency_key: "reject-workflow-output-loss-recovery",
        },
        { "x-keepr-test-now": reconciledAt },
      )
    ).response.status,
  ).toBe(200);
});

test("a complete Workflow recovers retained reconciliation after missing or malformed output while valid output remains binding-checked", async () => {
  const run = await collect("/reconciliation/base", "workflow-complete-output-recovery");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  let instanceStatus: Awaited<ReturnType<WorkflowInstance["status"]>> = {
    status: "running",
  };
  const instance = {
    status: async () => instanceStatus,
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const input = {
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "workflow-complete-output-recovery-request",
  };
  const accepted = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  expect(accepted.document.status).toBe("running");

  const retained = await reconcileRetainedCardPrintingEvidence(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.EVIDENCE_OBJECTS,
    run.id,
    "2026-07-31T01:00:00.000Z",
    testEnv.PRINTING_IMAGES,
  );
  const candidateDigest = requiredString(retained, "candidate_digest");
  for (const output of [undefined, { result_json: "not-json" }, { result_json: JSON.stringify([]) }]) {
    instanceStatus = { status: "complete", output };
    const recovered = await startOrObserveReconciliationWorkflow(
      catalogueStore(testEnv.CATALOGUE_DB),
      workflow,
      input,
      "2026-07-31T02:00:00.000Z",
    );
    expect(recovered.document).toMatchObject({
      status: "complete",
      output: {
        run_id: run.id,
        candidate_digest: candidateDigest,
      },
    });
  }

  instanceStatus = {
    status: "complete",
    output: {
      result_json: JSON.stringify({
        contract: "card-keepr-reconciliation-workflow-result@1",
        run_id: run.id,
        candidate_digest: "sha256_wrong_retained_candidate",
      }),
    },
  };
  await expect(
    startOrObserveReconciliationWorkflow(
      catalogueStore(testEnv.CATALOGUE_DB),
      workflow,
      input,
      "2026-07-31T03:00:00.000Z",
    ),
  ).rejects.toThrow("The reconciliation Workflow result does not bind the retained candidate.");
  expect(
    (
      await post(
        `/v1/ingestion-runs/${run.id}/rejection`,
        {
          candidate_digest: candidateDigest,
          idempotency_key: "reject-workflow-complete-output-recovery",
        },
        { "x-keepr-test-now": reconciledAt },
      )
    ).response.status,
  ).toBe(200);
});

test("exhausted reconciliation retries pause durable work and retain its reservation", async () => {
  const run = await collect("/reconciliation/base", "workflow-exhausted-retries");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  const step = {
    do: async (name: string, _config: unknown, callback: () => Promise<string>) => {
      if (name === "reconcile retained Card, Printing, and Erratum evidence") {
        throw new Error("injected exhausted retry limit");
      }
      return callback();
    },
  } as unknown as WorkflowStep;
  const output = await runReconciliationWorkflow(
    testEnv,
    {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: expectedCurrentRevisionId,
        idempotency_key: "workflow-exhausted-retries-request",
        observed_at: "2026-07-31T01:00:00.000Z",
      },
    } as WorkflowEvent<ReconciliationWorkflowParams>,
    step,
  );

  expect(JSON.parse(output.result_json)).toMatchObject({
    result: { run_id: run.id, state: "paused", publishable: false },
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect(requiredRecord((await get("/v1/status")).document.safe_state, "safe_state")).toMatchObject({
    active_ingestion_run_id: run.id,
  });
});

test("an exact replay pauses retained work when Workflow pause-finalization itself exhausts", async () => {
  const run = await collect("/reconciliation/base", "workflow-finalization-exhausted");
  const expectedCurrentRevisionId = requiredString(run.document, "expected_current_revision_id");
  let instanceStatus: Awaited<ReturnType<WorkflowInstance["status"]>> = {
    status: "running",
  };
  const instance = {
    status: async () => instanceStatus,
    resume: async () => {
      instanceStatus = { status: "running" };
    },
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const input = {
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "workflow-finalization-exhausted-request",
  };
  const accepted = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  expect(accepted.document.status).toBe("running");

  const exhaustingStep = {
    do: async (name: string) => {
      throw new Error(
        name.startsWith("finalize") ? "injected failure-finalization exhaustion" : "injected reconciliation exhaustion",
      );
    },
  } as unknown as WorkflowStep;
  await expect(
    runReconciliationWorkflow(
      testEnv,
      {
        payload: {
          ...input,
          observed_at: "2026-07-31T01:00:00.000Z",
        },
      } as WorkflowEvent<ReconciliationWorkflowParams>,
      exhaustingStep,
    ),
  ).rejects.toThrow("injected failure-finalization exhaustion");
  instanceStatus = {
    status: "errored",
    error: {
      name: "Error",
      message: "injected failure-finalization exhaustion",
    },
  };

  const recovered = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T02:00:00.000Z",
  );
  expect(recovered.document).toMatchObject({ status: "paused", output: null });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });

  instanceStatus = { status: "errored" };
  const exactReplay = await startOrObserveReconciliationWorkflow(
    catalogueStore(testEnv.CATALOGUE_DB),
    workflow,
    input,
    "2026-07-31T03:00:00.000Z",
  );
  expect(exactReplay.document).toEqual(recovered.document);
});

test("an empty published revision has an available projection and concurrent repair steps converge by CAS", async () => {
  const run = await collect("/reconciliation/complete-empty-lineage", "empty-query-revision");
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toEqual([]);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(published.document, "resulting_revision_id");
  await expect(
    publishedCatalogueQueries.countCatalogueQueryRevisionsDocumentCount(testEnv.CATALOGUE_DB).bind(revisionId).first(),
  ).resolves.toMatchObject({
    state: "available",
    document_count: 0,
  });

  await publishedCatalogueQueries.deleteCatalogueQueryRevisions(testEnv.CATALOGUE_DB).bind(revisionId).run();
  const repair = (idempotencyKey: string) =>
    post("/v1/catalogue-search-materialization/repair", {
      target_revision_id: revisionId,
      expected_current_revision_id: revisionId,
      idempotency_key: idempotencyKey,
    });
  const concurrent = await Promise.all([
    repair("empty-query-repair-concurrent-a"),
    repair("empty-query-repair-concurrent-b"),
  ]);
  expect(concurrent.map(({ response }) => response.status)).toEqual([200, 200]);
  expect(concurrent.map(({ document }) => document)).toEqual([
    expect.objectContaining({
      contract: "card-keepr-card-search-repair@1",
    }),
    expect.objectContaining({
      contract: "card-keepr-card-search-repair@1",
    }),
  ]);
  const complete =
    concurrent.find(({ document }) => document.complete === true) ?? (await repair("empty-query-repair-complete"));
  expect(complete.response.status).toBe(200);
  expect(complete.document).toMatchObject({ complete: true });
  await expect(
    publishedCatalogueQueries.readCatalogueQueryRevisionsState(testEnv.CATALOGUE_DB).bind(revisionId).first(),
  ).resolves.toMatchObject({ state: "available" });
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
  const firstRevision = requiredString(firstPublished.document, "resulting_revision_id");
  expect(await exportComponentRecords(firstRevision, "relationships")).toContainEqual(
    expect.objectContaining({
      kind: "printing-product",
      relationship_value: "product_op01",
    }),
  );

  const secondRun = await collect("/reconciliation/new-locator", "reconcile-new-locator");
  const second = await reconcile(secondRun.id);
  expect(second.response.status).toBe(200);
  expect(requiredFirst(second.document, "cards").id).toBe(firstCard.id);
  expect(requiredFirst(second.document, "printings").id).toBe(firstPrinting.id);
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
  const secondRevision = requiredString(secondPublished.document, "resulting_revision_id");

  const lifecycle = await get(`/v1/reconciliation/printings/${firstPrinting.id}`);
  expect(lifecycle.response.status).toBe(200);
  expect(lifecycle.document).toMatchObject({
    id: firstPrinting.id,
    card_id: firstCard.id,
    locators: {
      current: [
        expect.objectContaining({
          locator: "/official/renamed",
          current: true,
        }),
      ],
      historical: [
        expect.objectContaining({
          locator: "/official/base",
          current: false,
          last_missing_revision_id: secondRevision,
        }),
      ],
    },
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
    relationship_evidence: expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_kind: "product",
        relationship_value: "product_promotion",
        current: true,
        source_observation_ids: expect.arrayContaining([expect.stringMatching(/^srcobs_/)]),
      }),
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_kind: "product",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });
  expect(await exportComponentRecords(secondRevision, "printings")).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: secondRevision,
        withdrawn: false,
      },
    }),
  );
  expect(await exportComponentRecords(secondRevision, "products")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ official_code: "product_op01" }),
      expect.objectContaining({ official_code: "product_promotion" }),
    ]),
  );
  expect(await exportComponentRecords(secondRevision, "relationships")).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relationship_value: "product_op01",
        lifecycle: expect.objectContaining({ current: false }),
      }),
      expect.objectContaining({
        relationship_value: "product_promotion",
        lifecycle: expect.objectContaining({ current: true }),
      }),
    ]),
  );
  expect(await exportComponentRecords(secondRevision, "distribution-contexts")).toEqual([
    expect.objectContaining({
      id: expect.stringMatching(/^distribution_context_[a-f0-9]{64}$/),
      label: "context_event",
    }),
  ]);
  expect(JSON.stringify(await exportComponentRecords(secondRevision, "relationships"))).not.toContain("source_bucket");
  const publishedPrinting = await publishedCatalogueQueries
    .readRevisionPrintingsDocumentJsonForRetainedImmutableEvidencePublishesStableIdentitiesWarnsEarlierMembership(
      testEnv.CATALOGUE_DB,
    )
    .bind(secondRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  const publishedPrintingDocument = JSON.parse(publishedPrinting?.document_json ?? "{}") as {
    data: Record<string, unknown>;
  };
  expect(publishedPrintingDocument).toMatchObject({
    included: expect.any(Array),
    provenance: expect.any(Object),
    disagreements: expect.any(Array),
  });
  expect(publishedPrintingDocument.data).toMatchObject({
    distribution_contexts: [
      {
        id: expect.stringMatching(/^distribution_context_[a-f0-9]{64}$/),
        kind: "other",
        label: "context_event",
        product_id: null,
        evidence_category: "explicit",
      },
    ],
    relationship_evidence: expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });
  expect(publishedPrintingDocument.data.relationship_evidence).toEqual(lifecycle.document.relationship_evidence);
  expect(JSON.stringify(lifecycle.document.relationship_evidence)).not.toContain("source_bucket");
  expect(JSON.stringify(publishedPrintingDocument.data.relationship_evidence)).not.toContain("source_bucket");

  const withdrawalRun = await collect("/reconciliation/withdrawn", "reconcile-withdrawn");
  const withdrawal = await reconcile(withdrawalRun.id);
  expect(withdrawal.response.status).toBe(200);
  const withdrawalPublished = await approve(withdrawal.document);
  const withdrawalRevision = requiredString(withdrawalPublished.document, "resulting_revision_id");
  const withdrawn = await get(`/v1/reconciliation/printings/${firstPrinting.id}`);
  expect(withdrawn.document).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: withdrawalRevision,
      withdrawn: true,
      withdrawal: {
        revision_id: withdrawalRevision,
        evidence: {
          entity: "printing",
          assertion: "withdrawn",
          state: "withdrawn",
          effective_at: "2026-07-01T00:00:00.000Z",
          evidence: "Official withdrawal notice",
          source_lineage: "one-piece-en",
          source_snapshot_id: expect.stringMatching(/^srcsnap_/),
          source_observation_set_id: expect.stringMatching(/^srcobsset_/),
          source_observation_id: expect.stringMatching(/^srcobs_/),
        },
      },
    },
  });

  const exported = await exportComponentRecords(withdrawalRevision, "printings");
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: withdrawalRevision,
        withdrawn: true,
        withdrawal: {
          revision_id: withdrawalRevision,
        },
      },
    }),
  );
  const revisionDocument = await publishedCatalogueQueries
    .readRevisionPrintingsDocumentJsonForRetainedImmutableEvidencePublishesStableIdentitiesWarnsEarlierMembership(
      testEnv.CATALOGUE_DB,
    )
    .bind(withdrawalRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  expect(JSON.parse(revisionDocument?.document_json ?? "{}")).toMatchObject({
    data: {
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: withdrawalRevision,
        withdrawn: true,
      },
    },
  });
});

test("parsed observation count warnings use the normative absolute threshold", async () => {
  const firstRun = await collect("/reconciliation/observation-count-100", "observation-count-first");
  const first = await reconcile(firstRun.id);
  expect(first.response.status).toBe(200);
  expect((await approve(first.document)).response.status).toBe(200);

  const secondRun = await collect("/reconciliation/observation-count-124", "observation-count-second");
  const second = await reconcile(secondRun.id);
  expect(second.response.status).toBe(200);
  expect(second.document.warnings).not.toContainEqual(
    expect.objectContaining({
      code: "source_observation_count_changed",
    }),
  );
  expect((await approve(second.document)).response.status).toBe(200);

  const thirdRun = await collect("/reconciliation/observation-count-149", "observation-count-third");
  const third = await reconcile(thirdRun.id);
  expect(third.response.status).toBe(200);
  expect(third.document.warnings).toContainEqual(
    expect.objectContaining({
      code: "source_observation_count_changed",
      source_lineage: "one-piece-en",
      request_id: "one-piece-en:discovery",
      previous_count: 124,
      current_count: 149,
      absolute_delta: 25,
      warning_threshold: 25,
    }),
  );
});

test("an interrupted reconciliation publication recovers the exact digest-bound candidate and export", async () => {
  const run = await collectRequests(
    [
      { id: "non-empty", scenario: "base" },
      { id: "empty", scenario: "complete-empty-lineage" },
    ],
    "reconcile-interrupted",
  );
  const reconciled = await reconcile(run.id);
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(reconciled.document, "expected_current_revision_id");
  const persisted = await reconciliationQueries
    .readReconciliationPayloadChunks(testEnv.CATALOGUE_DB)
    .bind(run.id)
    .first<{
      candidate_json: string;
      candidate_catalogue_digest: string;
    }>();
  const candidate = JSON.parse(persisted?.candidate_json ?? "{}") as CatalogueCandidate;
  const revisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvedAt = "2026-07-29T02:00:00.000Z";
  const reconcileAfter = "2026-07-29T02:05:00.000Z";
  const approvalKey = "approve-reconciliation-interrupted";
  const _cardId = candidate.cards[0]!.id;
  const _printingId = candidate.printings[0]!.id;
  const publication = await reconciliationPublication(
    catalogueStore(testEnv.CATALOGUE_DB),
    run.id,
    revisionId,
    approvedAt,
  );
  if (publication === null) throw new Error("publication plan missing");
  const catalogueExport = await buildCatalogueExport(
    candidate,
    persisted?.candidate_catalogue_digest ?? "",
    revisionId,
    approvedAt,
    {
      cards: publication.cardLifecycles,
      printings: publication.printingLifecycles,
      products: publication.productLifecycles,
      productRelationships: publication.productRelationshipLifecycles,
      relationships: publication.relationshipEvidence,
      locators: publication.locatorEvidence,
      cardEvidence: publication.cardEvidence,
      printingEvidence: publication.printingEvidence,
    },
  );
  const approval = {
    action: "approved",
    approved_at: approvedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
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
    const body = object.body();
    await Promise.all([
      testEnv.CATALOGUE_EXPORTS.put(object.key, body.readable, {
        sha256: object.sha256,
      }),
      body.completed,
    ]);
  }

  const recovered = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: approvalKey,
  });
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

test("reserved recovery never adopts or cleans an existing published export prefix", async () => {
  const firstRun = await collect("/reconciliation/new-locator", "reservation-owner-existing-export");
  const firstReconciled = await reconcile(firstRun.id);
  const firstPublished = await approve(firstReconciled.document);
  expect(firstPublished.response.status).toBe(200);
  const existingRevision = requiredString(firstPublished.document, "resulting_revision_id");
  const existingManifest = requiredString(firstPublished.document, "export_manifest_digest");

  const run = await collect("/reconciliation/base", "reservation-owner-tampered-run");
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(reconciled.document, "expected_current_revision_id");
  const approvalKey = "approve-reservation-owner-tampered-run";
  const approval = {
    action: "approved",
    approved_at: "2026-07-29T02:00:00.000Z",
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await ingestionQueries
    .setIngestionRunsStateApprovalJson(testEnv.CATALOGUE_DB)
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: ["planning", "collecting", "parsing", "reconciling", "awaiting_approval"],
        current_stage: "publishing",
      }),
      existingRevision,
      approval.approved_at,
      "2026-07-29T02:05:00.000Z",
      existingManifest,
      `writer:${existingRevision}`,
      run.id,
    )
    .run();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort();
  const exportBefore = await catalogueExportQueries
    .readCatalogueExports(testEnv.CATALOGUE_DB)
    .bind(existingRevision)
    .first();

  const blocked = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: approvalKey,
  });
  expect(blocked.response.status).toBe(500);
  expect(blocked.document).toMatchObject({ code: "publication_abandoned" });
  const ownership = await ingestionQueries
    .countIngestionPublicationCleanup(testEnv.CATALOGUE_DB)
    .bind(run.id, approvalKey)
    .first<{
      cleanups: number;
      claims: number;
      active_ingestion_run_id: string | null;
      current_revision_id: string;
    }>();
  expect(ownership).toEqual({
    cleanups: 0,
    claims: 0,
    active_ingestion_run_id: null,
    current_revision_id: existingRevision,
  });
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects.map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(
    await catalogueExportQueries.readCatalogueExports(testEnv.CATALOGUE_DB).bind(existingRevision).first(),
  ).toEqual(exportBefore);

  const replay = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: approvalKey,
  });
  expect(replay.response.status).toBe(500);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
  });
});
