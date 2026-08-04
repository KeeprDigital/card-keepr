import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import {
  exports,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";
import { buildCatalogueExport } from "../../../src/catalogue/export";
import {
  compareSourceFreshness,
  sourceFreshnessFromStorage,
  sourceFreshnessKey,
  type SourceFreshnessStorageRow,
} from "../../../src/catalogue/source-freshness";
import {
  canonicalJson,
  sha256,
} from "../../../src/catalogue/serialization";
import {
  reconcileRetainedCardPrintingEvidence,
} from "../../../src/catalogue/card-printing-reconciliation";
import { reconciliationPublication } from "../../../src/catalogue/reconciliation-publication";
import {
  startOrObserveReconciliationWorkflow,
  type ReconciliationWorkflowParams,
} from "../../../src/catalogue/reconciliation-workflow";
import {
  catalogueCandidateContract,
  type CatalogueCandidate,
  type SupportedGame,
} from "../../../src/catalogue/catalogue-candidate";
import type { StartEvidenceRunRequest } from "../../../src/catalogue/source-evidence";
import { officialSourceDiscoveryRequests } from "../../../src/catalogue/product-release-source-adapters";
import { catalogueRevisionIdentity } from "../../../src/catalogue/idempotent-identities";
import {
  injectFixtureEvidencePlan,
  injectFixturePublication,
} from "./fixture-plan-injection";
import {
  EMPTY_CATALOGUE_GZIP_HEX,
  GZIP_PROFILE_GOLDENS,
} from "./deterministic-gzip-golden";
import {
  runReconciliationWorkflow,
} from "../src/reconciliation-workflow";
import ingestionWorker from "../src/index";

const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

test("registered Source metadata rejects unowned stored Legality freshness scopes", () => {
  expect(() => sourceFreshnessFromStorage({
    game: "gundam",
    area: "legality-rules",
    source_lineage: "gundam-en-future",
    region: "EN-ASIA",
    checked_at: "2026-08-02T00:00:00.000Z",
  })).toThrow(/registered ownership/);
});
let requestSequence = 0;

beforeEach(async () => {
  await applyD1Migrations(
    testEnv.CATALOGUE_DB,
    testEnv.TEST_MIGRATIONS,
  );
});

test("reconciliation is Workflow-owned and exact replays observe one bound instance", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-owned-reconciliation",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  const requestBody = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "workflow-owned-reconciliation-request",
  };
  const first = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    requestBody,
  );
  expect(first.response.status).toBe(202);
  expect(first.document).toMatchObject({
    contract: "card-keepr-reconciliation-workflow@1",
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: requestBody.idempotency_key,
    workflow_instance_id: expect.any(String),
  });

  const replay = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    requestBody,
  );
  expect(replay.response.status).toBe(200);
  expect(replay.document.workflow_instance_id).toBe(
    first.document.workflow_instance_id,
  );

  const conflicting = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      expected_current_revision_id: "catrev_conflicting_request",
      idempotency_key: requestBody.idempotency_key,
    },
  );
  expect(conflicting.response.status).toBe(409);
  expect(conflicting.document).toMatchObject({
    code: "idempotency_conflict",
  });

  const stale = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      expected_current_revision_id: "catrev_stale_request",
      idempotency_key: "workflow-owned-reconciliation-stale",
    },
  );
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({
    code: "current_revision_mismatch",
  });

  let completed = replay;
  const deadline = Date.now() + 15_000;
  while (completed.document.status !== "complete") {
    if (Date.now() >= deadline) {
      throw new Error(
        `reconciliation Workflow ${run.id} did not complete`,
      );
    }
    completed = await post(
      `/v1/ingestion-runs/${run.id}/reconciliation`,
      requestBody,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const output = requiredRecord(completed.document.output, "output");
  expect(output).toMatchObject({
    run_id: run.id,
    publishable: true,
  });
  const rejected = await post(
    `/v1/ingestion-runs/${run.id}/rejection`,
    {
      candidate_digest: requiredString(output, "candidate_digest"),
      idempotency_key: "reject-workflow-owned-reconciliation",
    },
  );
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({
    id: run.id,
    state: "rejected",
  });
  const terminalStatus = await get("/v1/status");
  expect(
    requiredRecord(terminalStatus.document.safe_state, "safe_state"),
  ).toMatchObject({
    active_ingestion_run_id: null,
  });
});

test("a Workflow that terminalizes during initial HTTP creation returns 200", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-terminal-on-http-create",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  let instanceStatus: Awaited<ReturnType<WorkflowInstance["status"]>> = {
    status: "running",
  };
  const instance = {
    status: async () => instanceStatus,
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => {
      const retained = await reconcileRetainedCardPrintingEvidence(
        testEnv.CATALOGUE_DB,
        testEnv.EVIDENCE_OBJECTS,
        run.id,
        "2026-07-31T01:00:00.000Z",
      );
      instanceStatus = {
        status: "complete",
        output: {
          result_json: JSON.stringify({
            contract: "card-keepr-reconciliation-workflow-result@1",
            run_id: run.id,
            candidate_digest: requiredString(
              retained,
              "candidate_digest",
            ),
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
    new Request(
      `https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation`,
      {
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
      },
    ),
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
    (await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: requiredString(output, "candidate_digest"),
        idempotency_key: "reject-workflow-terminal-on-http-create",
      },
    )).response.status,
  ).toBe(200);
});

test("an exact reconciliation replay observes without creating or executing the bound Workflow again", async () => {
  const run = await collect(
    "/reconciliation/base",
    "observe-only-workflow-replay",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  const createIds: string[] = [];
  const getIds: string[] = [];
  let durableOutput: { result_json: string } | null = null;
  let instanceExists = false;
  const instance = {
    status: async () =>
      durableOutput === null
        ? { status: "running" }
        : { status: "complete", output: durableOutput },
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async ({ id }: { id: string }) => {
      createIds.push(id);
      if (createIds.length > 1) {
        throw new Error("duplicate Workflow execution");
      }
      instanceExists = true;
      const result = await reconcileRetainedCardPrintingEvidence(
        testEnv.CATALOGUE_DB,
        testEnv.EVIDENCE_OBJECTS,
        run.id,
        "2026-07-31T01:00:00.000Z",
      );
      durableOutput = {
        result_json: JSON.stringify({
          contract: "card-keepr-reconciliation-workflow-result@1",
          run_id: run.id,
          candidate_digest: requiredString(
            result,
            "candidate_digest",
          ),
        }),
      };
      return instance;
    },
    get: async (id: string) => {
      getIds.push(id);
      return instanceExists
        ? instance
        : {
          status: async () => ({ status: "unknown" }),
        } as unknown as WorkflowInstance;
    },
  } as unknown as Workflow<ReconciliationWorkflowParams>;
  const input = {
    ingestion_run_id: run.id,
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: "observe-only-workflow-replay-request",
  };
  const first = await startOrObserveReconciliationWorkflow(
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  const replay = await startOrObserveReconciliationWorkflow(
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T01:01:00.000Z",
  );

  expect(first.created).toBe(true);
  expect(replay.created).toBe(false);
  expect(replay.document.workflow_instance_id).toBe(
    first.document.workflow_instance_id,
  );
  expect(createIds).toEqual([first.document.workflow_instance_id]);
  expect(getIds).toEqual([first.document.workflow_instance_id]);
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM reconciliation_workflow_requests
       WHERE ingestion_run_id = ?`,
    )
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
  );
  expect(rejected.response.status).toBe(200);
  expect(rejected.document).toMatchObject({
    id: run.id,
    state: "rejected",
  });
  const terminalStatus = await get("/v1/status");
  expect(
    requiredRecord(terminalStatus.document.safe_state, "safe_state"),
  ).toMatchObject({
    active_ingestion_run_id: null,
  });
});

test("an exact reconciliation replay recreates a deterministically bound instance after create loss", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-create-loss-recovery",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  const createParams: ReconciliationWorkflowParams[] = [];
  let instanceExists = false;
  const instance = {
    status: async () => ({ status: "running" }),
  } as unknown as WorkflowInstance;
  const workflow = {
    create: async (
      input: { id: string; params: ReconciliationWorkflowParams },
    ) => {
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
      testEnv.CATALOGUE_DB,
      workflow,
      input,
      "2026-07-31T01:00:00.000Z",
    ),
  ).rejects.toThrow("instance not found");
  const replay = await startOrObserveReconciliationWorkflow(
    testEnv.CATALOGUE_DB,
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
  const stored = await testEnv.CATALOGUE_DB.prepare(
    `SELECT workflow_params_json
     FROM reconciliation_workflow_requests
     WHERE ingestion_run_id = ?`,
  )
    .bind(run.id)
    .first<{ workflow_params_json: string }>();
  expect(JSON.parse(stored?.workflow_params_json ?? "null")).toEqual(
    createParams[0],
  );
  const reconciled = await reconcileRetainedCardPrintingEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    run.id,
    "2026-07-31T01:00:00.000Z",
  );
  expect(
    (await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: requiredString(reconciled, "candidate_digest"),
        idempotency_key: "reject-workflow-create-loss-recovery",
      },
    )).response.status,
  ).toBe(200);
});

test("reconciliation commit success survives lost step output without repeating semantic work", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-output-loss-recovery",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  let reconciliationAttempts = 0;
  const step = {
    do: async (
      name: string,
      _config: unknown,
      callback: () => Promise<string>,
    ) => {
      if (
        name ===
          "reconcile retained Card, Printing, and Erratum evidence"
      ) {
        reconciliationAttempts += 1;
        await callback();
        reconciliationAttempts += 1;
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
        idempotency_key: "workflow-output-loss-recovery-request",
        observed_at: "2026-07-31T01:00:00.000Z",
      },
    } as WorkflowEvent<ReconciliationWorkflowParams>,
    step,
  );

  expect(reconciliationAttempts).toBe(2);
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
    (await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: requiredString(durable, "candidate_digest"),
        idempotency_key: "reject-workflow-output-loss-recovery",
      },
    )).response.status,
  ).toBe(200);
});

test("a complete Workflow recovers retained reconciliation after missing or malformed output while valid output remains binding-checked", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-complete-output-recovery",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
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
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  expect(accepted.document.status).toBe("running");

  const retained = await reconcileRetainedCardPrintingEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    run.id,
    "2026-07-31T01:00:00.000Z",
  );
  const candidateDigest = requiredString(retained, "candidate_digest");
  for (const output of [
    undefined,
    { result_json: "not-json" },
    { result_json: JSON.stringify([]) },
  ]) {
    instanceStatus = { status: "complete", output };
    const recovered = await startOrObserveReconciliationWorkflow(
      testEnv.CATALOGUE_DB,
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
      testEnv.CATALOGUE_DB,
      workflow,
      input,
      "2026-07-31T03:00:00.000Z",
    ),
  ).rejects.toThrow(
    "The reconciliation Workflow result does not bind the retained candidate.",
  );
  expect(
    (await post(
      `/v1/ingestion-runs/${run.id}/rejection`,
      {
        candidate_digest: candidateDigest,
        idempotency_key: "reject-workflow-complete-output-recovery",
      },
    )).response.status,
  ).toBe(200);
});

test("exhausted reconciliation retries fail the run and release the global mutation lock", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-exhausted-retries",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
  const step = {
    do: async (
      name: string,
      _config: unknown,
      callback: () => Promise<string>,
    ) => {
      if (
        name ===
          "reconcile retained Card, Printing, and Erratum evidence"
      ) {
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
    result: {
      run_id: run.id,
      state: "failed",
      diagnostics: [
        expect.objectContaining({
          code: "reconciliation_workflow_failed",
        }),
      ],
    },
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({
    state: "failed",
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      "SELECT state, failure_code FROM ingestion_runs WHERE id = ?",
    )
      .bind(run.id)
      .first(),
  ).resolves.toMatchObject({
    state: "failed",
    failure_code: "reconciliation_workflow_failed",
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
    ).first(),
  ).resolves.toMatchObject({ active_ingestion_run_id: null });
  const status = await get("/v1/status");
  expect(status.response.status).toBe(200);
  expect(status.document.recent_runs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: run.id,
        state: "failed",
        failure_code: "reconciliation_workflow_failed",
      }),
    ]),
  );
});

test("an exact replay terminalizes a run when Workflow failure-finalization itself exhausts", async () => {
  const run = await collect(
    "/reconciliation/base",
    "workflow-finalization-exhausted",
  );
  const expectedCurrentRevisionId = requiredString(
    run.document,
    "expected_current_revision_id",
  );
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
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T01:00:00.000Z",
  );
  expect(accepted.document.status).toBe("running");

  const exhaustingStep = {
    do: async (name: string) => {
      throw new Error(
        name.startsWith("finalize")
          ? "injected failure-finalization exhaustion"
          : "injected reconciliation exhaustion",
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
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T02:00:00.000Z",
  );
  expect(recovered.document).toMatchObject({
    status: "complete",
    output: {
      run_id: run.id,
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "reconciliation_workflow_failed",
          detail: "injected failure-finalization exhaustion",
        }),
      ],
    },
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      "SELECT state, failure_code FROM ingestion_runs WHERE id = ?",
    )
      .bind(run.id)
      .first(),
  ).resolves.toMatchObject({
    state: "failed",
    failure_code: "reconciliation_workflow_failed",
  });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      "SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1",
    ).first(),
  ).resolves.toMatchObject({ active_ingestion_run_id: null });

  instanceStatus = { status: "errored" };
  const exactReplay = await startOrObserveReconciliationWorkflow(
    testEnv.CATALOGUE_DB,
    workflow,
    input,
    "2026-07-31T03:00:00.000Z",
  );
  expect(exactReplay.document).toEqual(recovered.document);
});

test("an empty published revision has an available projection and concurrent repair steps converge by CAS", async () => {
  const run = await collect(
    "/reconciliation/complete-empty-lineage",
    "empty-query-revision",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toEqual([]);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `SELECT query.state,
              COUNT(document.card_id) AS document_count
       FROM catalogue_query_revisions AS query
       LEFT JOIN revision_card_query_documents AS document
         ON document.catalogue_revision_id =
              query.catalogue_revision_id
       WHERE query.catalogue_revision_id = ?
       GROUP BY query.catalogue_revision_id, query.state`,
    )
      .bind(revisionId)
      .first(),
  ).resolves.toMatchObject({
    state: "available",
    document_count: 0,
  });

  await testEnv.CATALOGUE_DB.prepare(
    `DELETE FROM catalogue_query_revisions
     WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).run();
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
  expect(concurrent.map(({ response }) => response.status)).toEqual([
    200,
    200,
  ]);
  expect(concurrent.map(({ document }) => document)).toEqual([
    expect.objectContaining({
      contract: "card-keepr-card-search-repair@1",
    }),
    expect.objectContaining({
      contract: "card-keepr-card-search-repair@1",
    }),
  ]);
  const complete = concurrent.find(
    ({ document }) => document.complete === true,
  ) ?? await repair("empty-query-repair-complete");
  expect(complete.response.status).toBe(200);
  expect(complete.document).toMatchObject({ complete: true });
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `SELECT state FROM catalogue_query_revisions
       WHERE catalogue_revision_id = ?`,
    ).bind(revisionId).first(),
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
  const firstRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  expect(
    await exportComponentRecords(firstRevision, "relationships"),
  ).toContainEqual(
    expect.objectContaining({
      kind: "printing-product",
      relationship_value: "product_op01",
      evidence_category: "derived",
    }),
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
        source_observation_ids: expect.arrayContaining([
          expect.stringMatching(/^srcobs_/),
        ]),
      }),
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_kind: "product",
        relationship_value: "product_op01",
        current: false,
      }),
    ]),
  });
  expect(
    await exportComponentRecords(secondRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: secondRevision,
        withdrawn: false,
      },
    }),
  );
  expect(
    await exportComponentRecords(secondRevision, "products"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ official_code: "product_op01" }),
      expect.objectContaining({ official_code: "product_promotion" }),
    ]),
  );
  expect(
    await exportComponentRecords(secondRevision, "relationships"),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_op01",
        lifecycle: expect.objectContaining({ current: false }),
      }),
      expect.objectContaining({
        source_lineage: "one-piece-en",
        relationship_value: "product_promotion",
        lifecycle: expect.objectContaining({ current: true }),
      }),
    ]),
  );
  expect(
    await exportComponentRecords(
      secondRevision,
      "distribution-contexts",
    ),
  ).toEqual([
    expect.objectContaining({
      id: expect.stringMatching(/^distribution_context_[a-f0-9]{64}$/),
      label: "context_event",
    }),
  ]);
  expect(
    JSON.stringify(
      await exportComponentRecords(secondRevision, "relationships"),
    ),
  ).not.toContain("source_bucket");
  const publishedPrinting = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`,
  )
    .bind(secondRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  const publishedPrintingDocument = JSON.parse(
    publishedPrinting?.document_json ?? "{}",
  ) as { data: Record<string, unknown> };
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
  expect(publishedPrintingDocument.data.relationship_evidence).toEqual(
    lifecycle.document.relationship_evidence,
  );
  expect(
    JSON.stringify(lifecycle.document.relationship_evidence),
  ).not.toContain("source_bucket");
  expect(
    JSON.stringify(publishedPrintingDocument.data.relationship_evidence),
  ).not.toContain("source_bucket");

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

  const exported = await exportComponentRecords(
    withdrawalRevision,
    "printings",
  );
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: firstPrinting.id,
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
    }),
  );
  const revisionDocument = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json FROM revision_printings
     WHERE catalogue_revision_id = ? AND printing_id = ?`,
  )
    .bind(withdrawalRevision, firstPrinting.id)
    .first<{ document_json: string }>();
  expect(
    JSON.parse(revisionDocument?.document_json ?? "{}"),
  ).toMatchObject({
    data: {
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: withdrawalRevision,
        withdrawn: true,
      },
    },
  });
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
  const expectedRevision = requiredString(
    reconciled.document,
    "expected_current_revision_id",
  );
  const persisted = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       CASE
         WHEN candidate_json =
           '{"chunked_reconciliation_payload":"candidate"}'
         THEN (
           SELECT group_concat(content, '')
           FROM (
             SELECT content
             FROM reconciliation_payload_chunks
             WHERE ingestion_run_id = ingestion_runs.id
               AND payload_kind = 'candidate'
             ORDER BY chunk_index
           )
         )
         ELSE candidate_json
       END AS candidate_json,
       candidate_catalogue_digest
     FROM ingestion_runs
     WHERE id = ?`,
  )
    .bind(run.id)
    .first<{
      candidate_json: string;
      candidate_catalogue_digest: string;
    }>();
  const candidate = JSON.parse(
    persisted?.candidate_json ?? "{}",
  ) as CatalogueCandidate;
  const revisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvedAt = "2026-07-29T02:00:00.000Z";
  const reconcileAfter = "2026-07-29T02:05:00.000Z";
  const approvalKey = "approve-reconciliation-interrupted";
  const cardId = candidate.cards[0]!.id;
  const printingId = candidate.printings[0]!.id;
  const publication = await reconciliationPublication(
    testEnv.CATALOGUE_DB,
    run.id,
    revisionId,
    approvedAt,
  );
  if (publication === null) throw new Error("publication plan missing");
  const priorFreshness = await testEnv.CATALOGUE_DB.prepare(
    `SELECT game, area, source_lineage, region, checked_at
     FROM source_freshness
     WHERE area IN (
       'cards-and-printings', 'products-and-releases', 'legality-rules'
     )`,
  ).all<SourceFreshnessStorageRow>();
  const exactFreshness = new Map(
    priorFreshness.results
      .map(sourceFreshnessFromStorage)
      .filter(({ game }) => candidate.selected_games.includes(game))
      .map((check) => [sourceFreshnessKey(check), check]),
  );
  for (const check of candidate.source_checks ?? []) {
    exactFreshness.set(sourceFreshnessKey(check), check);
  }
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
    [...exactFreshness.values()].sort(compareSourceFreshness),
  );
  const approval = {
    action: "approved",
    approved_at: approvedAt,
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'publishing',
         approval_json = ?,
         approval_idempotency_key = ?,
         approval_history_json = ?,
         progress_json = ?,
         publication_revision_id = ?,
         publication_started_at = ?,
         publication_reconcile_after = ?,
         publication_manifest_digest = ?,
         publication_writer_token = ?
     WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
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

  const recovered = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    {
      candidate_digest: digest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: approvalKey,
    },
  );
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
  const firstRun = await collect(
    "/reconciliation/new-locator",
    "reservation-owner-existing-export",
  );
  const firstReconciled = await reconcile(firstRun.id);
  const firstPublished = await approve(firstReconciled.document);
  expect(firstPublished.response.status).toBe(200);
  const existingRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const existingManifest = requiredString(
    firstPublished.document,
    "export_manifest_digest",
  );

  const run = await collect(
    "/reconciliation/base",
    "reservation-owner-tampered-run",
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(
    reconciled.document,
    "expected_current_revision_id",
  );
  const approvalKey = "approve-reservation-owner-tampered-run";
  const approval = {
    action: "approved",
    approved_at: "2026-07-29T02:00:00.000Z",
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'publishing',
         approval_json = ?,
         approval_idempotency_key = ?,
         approval_history_json = ?,
         progress_json = ?,
         publication_revision_id = ?,
         publication_started_at = ?,
         publication_reconcile_after = ?,
         publication_manifest_digest = ?,
         publication_writer_token = ?
     WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
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
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list())
    .objects.map((object) => object.key).sort();
  const exportBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT * FROM catalogue_exports WHERE catalogue_revision_id = ?`,
  ).bind(existingRevision).first();

  const blocked = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    {
      candidate_digest: digest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: approvalKey,
    },
  );
  expect(blocked.response.status).toBe(500);
  expect(blocked.document).toMatchObject({ code: "publication_abandoned" });
  const ownership = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanups,
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id,
       (SELECT current_revision_id FROM catalogue_state
        WHERE singleton = 1) AS current_revision_id`,
  )
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
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT * FROM catalogue_exports WHERE catalogue_revision_id = ?`,
  ).bind(existingRevision).first()).toEqual(exportBefore);

  const replay = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    {
      candidate_digest: digest,
      expected_current_revision_id: expectedRevision,
      idempotency_key: approvalKey,
    },
  );
  expect(replay.response.status).toBe(500);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
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
  const inspected = await get(
    `/v1/ingestion-runs/${run.id}/candidate`,
  );
  expect(inspected.response.status).toBe(200);
  expect(inspected.document).toMatchObject({
    run_id: run.id,
    candidate_digest: requiredString(
      blocked.document,
      "candidate_digest",
    ),
    diff: {
      printings: {
        added: expect.any(Array),
      },
    },
  });
  const retried = await post(`/v1/ingestion-runs/${run.id}/retry`, {
    idempotency_key: "blocked-candidate-generic-retry",
  });
  expect(retried.response.status).toBe(409);
  expect(retried.document).toMatchObject({
    code: "evidence_retry_required",
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

test("a novel flag without structurally complete adapter and Printing Image evidence blocks publication", async () => {
  const run = await collect(
    "/reconciliation/incomplete-appearance",
    "reconcile-incomplete-appearance",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "printing_match_insufficient_evidence",
        detail: expect.stringContaining("structurally complete"),
      },
    ],
  });
});

test("immutable Observation Set counts, not an observation novelty assertion, decide structural completeness", async () => {
  const run = await collect(
    "/reconciliation/set-count-mismatch",
    "reconcile-set-count-mismatch",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "Source Observation Set provenance is invalid",
        ),
      },
    ],
  });
});

test("unknown controlled vocabulary remains retained evidence, warns, and stays out of the Game Profile", async () => {
  const run = await collect(
    "/reconciliation/unknown-vocabulary",
    "reconcile-unknown-vocabulary",
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
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
  expect(Array.isArray(warnings) ? warnings : []).toContainEqual(
    expect.objectContaining({
      code: "unknown_source_field",
      path: "new_official_label",
      raw_value: "Bandai-added-value",
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

test.each([
  {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@1",
    scenario: "profile-fusion-world",
    profile: "fusion-world@1",
    identity: "FB01-001",
    printingCount: 1,
  },
  {
    game: "digimon",
    lineage: "digimon-en",
    adapter: "fixture-digimon-json@1",
    scenario: "profile-digimon",
    profile: "digimon@1",
    identity: "BT1-001",
    printingCount: 1,
  },
  {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@1",
    scenario: "profile-gundam",
    profile: "gundam@1",
    identity: "GD01-001",
    printingCount: 1,
  },
  {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-json@1",
    scenario: "profile-don",
    profile: "one-piece@1",
    identity: "DON!!",
    printingCount: 0,
  },
])(
  "publishes accepted $profile identity without one-printing assumptions",
  async ({
    game,
    lineage,
    adapter,
    scenario,
    profile,
    identity,
    printingCount,
  }) => {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `reconcile-${scenario}`,
      { game, lineage, adapter },
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const card = requiredFirst(reconciled.document, "cards");
    expect(card).toMatchObject({
      game,
      official_identity: {
        kind:
          identity === "DON!!"
            ? "functional_designation"
            : "card_number",
        value: identity,
      },
      game_data: { profile },
    });
    expect(
      Array.isArray(reconciled.document.printings)
        ? reconciled.document.printings
        : [],
    ).toHaveLength(printingCount);
    const published = await approve(reconciled.document);
    if (published.response.status !== 200) {
      throw new Error(JSON.stringify(published.document));
    }
    expect(published.response.status).toBe(200);
  },
);

test("production adapters retain parser-bound coverage proof for reconciliation", async () => {
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@4",
    idempotency_key: "reconcile-production-adapter-without-coverage",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(started.response.status).toBe(201);
  const run = {
    id: requiredString(started.document, "id"),
  };
  const resumed = await post(
    `/v1/ingestion-runs/${run.id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  const completed = await waitForRunState(run.id, "awaiting_approval");
  expect(completed).toMatchObject({
    state: "awaiting_approval",
  });
  const candidate = await get(`/v1/ingestion-runs/${run.id}/candidate`);
  expect(candidate.response.status).toBe(200);
  expect(candidate.document).toMatchObject({
    run_id: run.id,
    candidate_digest: expect.any(String),
    expected_current_revision_id: expect.any(String),
    diff: {
      cards: { added: [] },
      printings: { added: [] },
    },
  });
  expect((await approve(candidate.document)).response.status).toBe(200);
});

test("new collection rejects a superseded adapter while retained snapshots reparse with their exact capturing version", async () => {
  const blocked = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@3",
    idempotency_key: "reject-superseded-production-adapter",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({ code: "adapter_not_supported" });

  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@4",
    idempotency_key: "active-adapter-retained-reparse-source",
    requests: officialSourceDiscoveryRequests("fusion-world-en"),
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect((await post(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    {},
  )).response.status).toBe(202);

  await waitForRunState(runId, "awaiting_approval");
  const snapshot = await testEnv.CATALOGUE_DB.prepare(
    `SELECT snapshot.id
     FROM source_snapshots AS snapshot
     WHERE snapshot.ingestion_run_id = ?
       AND snapshot.request_id = 'fusion-world-en:legality-current'`,
  ).bind(runId).first<{ id: string }>();
  if (snapshot === null) throw new Error("Retained legality snapshot is absent");
  const reparsed = await post(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    {
      adapter_version: "fusion-world-en@4",
      idempotency_key: "capturing-adapter-retained-reparse",
    },
  );
  expect(reparsed.response.status).toBe(201);
  expect(reparsed.document).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "fusion-world-en@4",
  });
  const candidate = await get(`/v1/ingestion-runs/${runId}/candidate`);
  expect((await post(`/v1/ingestion-runs/${runId}/rejection`, {
    candidate_digest: requiredString(candidate.document, "candidate_digest"),
    idempotency_key: "reject-active-adapter-retained-reparse-source",
  })).response.status).toBe(200);
}, 30_000);

test("complete image evidence publishes an unidentified artwork once without collapsing a new locator", async () => {
  const collectVariant = async (
    variant:
      | "base"
      | "base-reencoded"
      | "no-artwork-id"
      | "alternate"
      | "alternate-two",
    expectedState = "awaiting_approval",
  ) => {
    const requests = officialSourceDiscoveryRequests("digimon-en").map(
      (sourceRequest) => ({
        ...sourceRequest,
        headers: {
          ...sourceRequest.headers,
          "user-agent": `card-keepr-artwork-digest-${variant}`,
        },
      }),
    );
    const started = await post("/v1/ingestion-runs/evidence", {
      supported_game: "digimon",
      source_lineage: "digimon-en",
      adapter_version: "digimon-en@3",
      idempotency_key: `digimon-artwork-digest-${variant}`,
      requests,
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    expect(
      (
        await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})
      ).response.status,
    ).toBe(202);
    const state = await waitForRunState(
      runId,
      expectedState,
      20_000,
      250,
    );
    if (expectedState === "failed") return state;
    const candidate = await get(
      `/v1/ingestion-runs/${runId}/candidate`,
    );
    expect(candidate.response.status).toBe(200);
    return candidate.document;
  };

  const first = await collectVariant("base");
  expect(first).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const firstPrintingId = (
    first.diff as { printings: { added: string[] } }
  ).printings.added[0]!;
  expect((await approve(first)).response.status).toBe(200);

  const reencoded = await collectVariant("base-reencoded");
  expect(reencoded).toMatchObject({
    diff: { printings: { added: [] } },
  });
  expect((await approve(reencoded)).response.status).toBe(200);

  const locatorOnly = await collectVariant("no-artwork-id", "failed");
  expect(locatorOnly).toMatchObject({
    state: "failed",
    failure_code: "printing_reconciliation_blocked",
  });

  const second = await collectVariant("alternate");
  expect(second).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const secondPrintingId = (
    second.diff as { printings: { added: string[] } }
  ).printings.added[0]!;
  expect((await approve(second)).response.status).toBe(200);

  const third = await collectVariant("alternate-two");
  expect(third).toMatchObject({
    diff: { printings: { added: [expect.any(String)] } },
  });
  const thirdPrintingId = (
    third.diff as { printings: { added: string[] } }
  ).printings.added[0]!;
  const targetPrintingIds = new Set([
    firstPrintingId,
    secondPrintingId,
    thirdPrintingId,
  ]);
  expect(targetPrintingIds.size).toBe(3);
  const published = await approve(third);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const [printings, images] = await Promise.all([
    exportComponentRecords(revisionId, "printings"),
    exportComponentRecords(revisionId, "printing-images"),
  ]);
  const targetPrintings = printings.filter(({ id }) =>
    targetPrintingIds.has(String(id)),
  );
  const targetImages = images.filter(({ printing_id }) =>
    targetPrintingIds.has(String(printing_id)),
  );
  expect(targetPrintings).toHaveLength(3);
  expect(new Set(targetPrintings.map(({ id }) => id))).toEqual(
    targetPrintingIds,
  );
  expect(targetImages).toHaveLength(4);
  expect(new Set(targetImages.map(({ printing_id }) => printing_id))).toEqual(
    targetPrintingIds,
  );
  expect(
    new Set(targetImages.map(({ content_sha256 }) => content_sha256)).size,
  ).toBe(4);
  expect(
    targetImages
      .filter(({ printing_id }) => printing_id === firstPrintingId)
      .map(({ width, height }) => `${width}x${height}`)
      .sort(),
  ).toEqual(["1x1", "2x2"]);
}, 120_000);

test("production Evidence Plans bind discovery identity to its exact Official Source URL", async () => {
  const requests = officialSourceDiscoveryRequests("one-piece-en").map(
    (request) => ({ ...request }),
  );
  requests[0]!.url =
    "https://official-source.invalid/one-piece-en/products";
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@2",
    idempotency_key: "forged-production-surface-url",
    requests,
  });
  expect(started.response.status).toBe(422);
  expect(started.document).toMatchObject({
    code: "source_surface_binding_mismatch",
  });
});

test("the production source-plan route rejects synthetic fixture adapters without creating provenance", async () => {
  const blocked = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "production-route-fixture-bypass",
    requests: [
      {
        id: "cards",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/base",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "adapter_origin_not_permitted",
  });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM ingestion_evidence_plans AS plan
     JOIN ingestion_runs AS run ON run.id = plan.ingestion_run_id
     WHERE run.idempotency_key = 'production-route-fixture-bypass'`,
  ).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("the production Worker has no route capable of injecting synthetic fixture plans", async () => {
  const blocked = await post(
    "/v1/internal/fixture-ingestion-runs/evidence",
    {},
  );
  expect(blocked.response.status).toBe(404);
  expect(blocked.document).toMatchObject({ code: "not_found" });

  const legacyFixturePublication = await post("/v1/ingestion-runs", {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "production-fixture-publication-bypass",
  });
  expect(legacyFixturePublication.response.status).toBe(404);
  expect(legacyFixturePublication.document).toMatchObject({
    code: "not_found",
  });
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM ingestion_runs
     WHERE idempotency_key = 'production-fixture-publication-bypass'`,
  ).first<{ count: number }>();
  expect(retained?.count).toBe(0);
});

test("one complete retained set can publish multiple Printings without collapsing their identities", async () => {
  const run = await collect(
    "/reconciliation/multi-printing",
    "reconcile-multi-printing",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(2);
  const printingIds = (
    reconciled.document.printings as Record<string, unknown>[]
  ).map((printing) => printing.id);
  expect(new Set(printingIds).size).toBe(2);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("Product lifecycle aggregates every related Printing deterministically", async () => {
  const firstRun = await collect(
    "/reconciliation/product-lifecycle-first",
    "reconcile-product-lifecycle-first",
  );
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const firstRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );

  const multipleRun = await collect(
    "/reconciliation/product-lifecycle-multiple",
    "reconcile-product-lifecycle-multiple",
  );
  const multiple = await reconcile(multipleRun.id);
  const multiplePublished = await approve(multiple.document);
  const latestRevision = requiredString(
    multiplePublished.document,
    "resulting_revision_id",
  );
  const product = (
    await exportComponentRecords(latestRevision, "products")
  ).find(
    (record) =>
      record.game === "one-piece" &&
      record.official_code === "product_lifecycle_shared",
  );
  expect(product).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: latestRevision,
      withdrawn: false,
    },
  });
});

test("the profile registry strips and warns on unknown nested fields while enforcing exact numeric types", async () => {
  const warningRun = await collect(
    "/reconciliation/profile-nested-unknown",
    "reconcile-profile-nested-unknown",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const warned = await reconcile(warningRun.id);
  expect(warned.response.status).toBe(200);
  expect(warned.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.specified_cost[0].new_metric",
        raw_value: "retained raw",
      }),
      expect.objectContaining({
        code: "unknown_source_field",
        path: "card.skills[0].new_label",
        raw_value: "retained raw",
      }),
    ]),
  );
  expect(JSON.stringify(requiredFirst(warned.document, "cards"))).not.toContain(
    "new_metric",
  );
  await post(`/v1/ingestion-runs/${warningRun.id}/rejection`, {
    candidate_digest: requiredString(warned.document, "candidate_digest"),
    idempotency_key: "reject-nested-profile-warning",
  });

  const invalidRun = await collect(
    "/reconciliation/profile-invalid-number",
    "reconcile-profile-invalid-number",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const invalid = await reconcile(invalidRun.id);
  expect(invalid.response.status).toBe(409);
  expect(invalid.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining("card.cost"),
      },
    ],
  });
});

test("a structurally complete non-DON Card may have zero catalogued Printings", async () => {
  const run = await collect(
    "/reconciliation/card-without-printing",
    "reconcile-card-without-printing",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toEqual([]);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("DON!! accepts explicit known Printing evidence while retaining incomplete-coverage warning semantics", async () => {
  const run = await collect(
    "/reconciliation/profile-don-printing",
    "reconcile-don-known-printing",
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.cards).toHaveLength(1);
  expect(reconciled.document.printings).toHaveLength(1);
  expect(reconciled.document.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_coverage_incomplete",
        card_id: requiredString(
          requiredFirst(reconciled.document, "cards"),
          "id",
        ),
      }),
    ]),
  );
  await approve(reconciled.document);
});

test("unnumbered DON!! receives direct and combination Legality Rules through publication", async () => {
  const run = await collect(
    "/reconciliation/profile-don-legality",
    "reconcile-don-legality",
    {
      game: "one-piece",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
    },
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const cards = reconciled.document.cards as Array<Record<string, unknown>>;
  const don = cards.find(
    (card) =>
      (card.official_identity as Record<string, unknown>).kind ===
      "functional_designation",
  );
  const companion = cards.find(
    (card) =>
      (card.official_identity as Record<string, unknown>).value ===
      "OP30-001",
  );
  if (don === undefined || companion === undefined) {
    throw new Error("DON!! legality fixture cards are absent");
  }
  const donId = requiredString(don, "id");
  const companionId = requiredString(companion, "id");
  const rules = reconciled.document.legality_rules as Array<
    Record<string, unknown>
  >;
  for (const officialId of [
    "don-ban",
    "don-copy-limit",
    "don-combination",
  ]) {
    expect(
      rules.find((rule) => rule.official_id === officialId),
    ).toMatchObject({ card_ids: [donId] });
  }
  expect(
    rules.find((rule) => rule.official_id === "don-combination"),
  ).toMatchObject({
    effect: {
      type: "prohibited_combination",
      with_card_ids: [companionId],
    },
  });

  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
});

test("functional DON!! identity rejects a non-don Card shape even when Printing evidence exists", async () => {
  const run = await collect(
    "/reconciliation/profile-don-invalid-printing",
    "reconcile-invalid-don-printing",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "functional DON!! identity requires",
        ),
      },
    ],
  });
});

test("numbered One Piece identities cannot claim the functional DON card type", async () => {
  const run = await collect(
    "/reconciliation/profile-numbered-don-invalid",
    "reconcile-invalid-numbered-don",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    diagnostics: [
      {
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "card_type don requires functional DON!! identity",
        ),
      },
    ],
  });
});

test("official numbered identities canonicalize permitted case and reject whitespace or malformed variants", async () => {
  const lowerRun = await collect(
    "/reconciliation/identity-lower",
    "reconcile-identity-lower",
  );
  const lower = await reconcile(lowerRun.id);
  expect(lower.response.status).toBe(200);
  const cardId = requiredString(requiredFirst(lower.document, "cards"), "id");
  expect(requiredFirst(lower.document, "cards")).toMatchObject({
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(lower.document);

  const upperRun = await collect(
    "/reconciliation/identity-upper",
    "reconcile-identity-upper",
  );
  const upper = await reconcile(upperRun.id);
  expect(upper.response.status).toBe(200);
  expect(requiredFirst(upper.document, "cards")).toMatchObject({
    id: cardId,
    official_identity: { kind: "card_number", value: "OP06-006" },
  });
  await approve(upper.document);

  for (const scenario of ["identity-whitespace", "identity-malformed"]) {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `reconcile-${scenario}`,
    );
    const blocked = await reconcile(run.id);
    expect(blocked.response.status).toBe(409);
    expect(blocked.document).toMatchObject({
      diagnostics: [
        {
          code: "retained_evidence_invalid",
          detail: expect.stringContaining("official card number"),
        },
      ],
    });
  }
});

test("conflicting explicit withdrawal assertions fail during reconciliation with stable diagnostics", async () => {
  const run = await collect(
    "/reconciliation/withdrawal-conflict",
    "reconcile-withdrawal-conflict",
  );
  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "withdrawal_evidence_conflict",
        detail: expect.stringContaining("withdrawal assertions conflict"),
      }),
    ],
  });
});

test("withdrawal assertions are longitudinal, append-only, and preserve the first transition", async () => {
  const firstRun = await collect(
    "/reconciliation/withdrawn-longitudinal",
    "reconcile-withdrawal-longitudinal-first",
  );
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const firstRevision = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const printingId = requiredString(
    requiredFirst(first.document, "printings"),
    "id",
  );

  const repeatRun = await collect(
    "/reconciliation/withdrawn-longitudinal-corroboration",
    "reconcile-withdrawal-longitudinal-repeat",
  );
  const repeat = await reconcile(repeatRun.id);
  expect(repeat.response.status).toBe(200);
  expect(repeat.document.candidate_digest).not.toBe(
    first.document.candidate_digest,
  );
  const repeated = await approve(repeat.document);
  expect(repeated.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: firstRevision,
  });
  const retained = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(retained.document).toMatchObject({
    lifecycle: {
      withdrawn: true,
      withdrawal: { revision_id: firstRevision },
    },
  });
  const history = await testEnv.CATALOGUE_DB.prepare(
    `SELECT evidence_json
     FROM reconciled_withdrawal_assertions
     WHERE entity_type = 'printing' AND entity_id = ?
     ORDER BY source_observation_id`,
  )
    .bind(printingId)
    .all<{ evidence_json: string }>();
  expect(history.results).toHaveLength(2);

  const conflictRun = await collect(
    "/reconciliation/withdrawn-conflicting-later",
    "reconcile-withdrawal-longitudinal-conflict",
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [
      expect.objectContaining({ code: "withdrawal_evidence_conflict" }),
    ],
  });
});

test("Gundam EN-ASIA and EN-US evidence converges on one Printing while substantive conflict blocks", async () => {
  const asiaRun = await collect(
    "/reconciliation/gundam-cross-asia",
    "reconcile-gundam-cross-asia",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  const printingId = requiredString(
    requiredFirst(asia.document, "printings"),
    "id",
  );
  await approve(asia.document);

  const usRun = await collect(
    "/reconciliation/gundam-cross-us",
    "reconcile-gundam-cross-us",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  expect(requiredFirst(us.document, "printings")).toMatchObject({
    id: printingId,
  });
  await approve(us.document);
  const lifecycle = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(lifecycle.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        locator: "/official/gundam/gundam-cross-asia",
        source_lineage: "gundam-en-asia",
        current: true,
      }),
      expect.objectContaining({
        locator: "/official/gundam/gundam-cross-us",
        source_lineage: "gundam-en-us",
        current: true,
      }),
    ],
    historical: [],
  });
  expect(lifecycle.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
        current: true,
      }),
    ]),
  );

  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "reconcile-gundam-cross-us-whole-printing-omitted",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const usMissing = await reconcile(usMissingRun.id);
  const inspected = await get(
    `/v1/ingestion-runs/${usMissingRun.id}/candidate`,
  );
  expect(inspected.document.diff).toMatchObject({
    printings: {
      missing_observations: [printingId],
    },
  });
  const usMissingPublished = await approve(usMissing.document);
  const usMissingRevision = requiredString(
    usMissingPublished.document,
    "resulting_revision_id",
  );
  const omittedCardObservation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current, last_missing_revision_id
     FROM reconciled_card_observations
     WHERE card_id = ? AND source_lineage = 'gundam-en-us'
     ORDER BY catalogue_revision_id DESC
     LIMIT 1`,
  )
    .bind(requiredString(requiredFirst(us.document, "cards"), "id"))
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedCardObservation).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const omittedPrintingLocator = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current, last_missing_revision_id
     FROM reconciled_printing_locators
     WHERE printing_id = ? AND source_lineage = 'gundam-en-us'`,
  )
    .bind(printingId)
    .first<{ current: number; last_missing_revision_id: string | null }>();
  expect(omittedPrintingLocator).toEqual({
    current: 0,
    last_missing_revision_id: usMissingRevision,
  });
  const isolated = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(isolated.document.relationship_evidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source_lineage: "gundam-en-asia",
        relationship_value: "product_gd99",
        current: true,
      }),
      expect.objectContaining({
        source_lineage: "gundam-en-us",
        relationship_value: "product_gd99",
        current: false,
      }),
    ]),
  );

  const cardConflictRun = await collect(
    "/reconciliation/gundam-card-conflict",
    "reconcile-gundam-card-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const cardConflict = await reconcile(cardConflictRun.id);
  expect(cardConflict.response.status).toBe(409);
  expect(cardConflict.document).toMatchObject({
    diagnostics: [
      {
        code: "canonical_card_conflict",
        detail: expect.stringContaining("source lineages"),
      },
    ],
  });

  const conflictRun = await collect(
    "/reconciliation/gundam-cross-conflict",
    "reconcile-gundam-cross-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const conflict = await reconcile(conflictRun.id);
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({
    diagnostics: [
      {
        code: "printing_match_contradictory",
        candidate_printing_ids: [printingId],
      },
    ],
  });

  for (const [scenario, key] of [
    [
      "gundam-cross-product-conflict",
      "reconcile-gundam-product-conflict",
    ],
    [
      "gundam-cross-variant-conflict",
      "reconcile-gundam-variant-conflict",
    ],
  ] as const) {
    const mismatchRun = await collect(
      `/reconciliation/${scenario}`,
      key,
      {
        game: "gundam",
        lineage: "gundam-en-us",
        adapter: "fixture-gundam-en-us-json@1",
      },
    );
    const mismatch = await reconcile(mismatchRun.id);
    expect(mismatch.response.status).toBe(200);
    expect(requiredFirst(mismatch.document, "printings")).toMatchObject({
      id: printingId,
    });
    await approve(mismatch.document);
  }
}, 30_000);

test("Gundam Printing identity is independent of locale observation order when EN-US is first", async () => {
  const usRun = await collect(
    "/reconciliation/gundam-mirror-us",
    "stable-id-en-us-first",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  const printingId = requiredString(
    requiredFirst(us.document, "printings"),
    "id",
  );
  expect(printingId).toBe(
    "printing_133c063736fd275c675f6db014416609",
  );
  await approve(us.document);

  const asiaRun = await collect(
    "/reconciliation/gundam-mirror-asia",
    "stable-id-en-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  expect(requiredFirst(asia.document, "printings")).toMatchObject({
    id: printingId,
  });
  await approve(asia.document);
}, 20_000);

test("Gundam EN-ASIA Printing facts remain canonical when formatting-equivalent EN-US evidence arrives later", async () => {
  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-first",
    "gundam-printing-format-asia-first",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  const printingId = requiredString(
    requiredFirst(asia.document, "printings"),
    "id",
  );
  const firstPublished = await approve(asia.document);
  expect(firstPublished.response.status).toBe(200);

  const usRun = await collect(
    "/reconciliation/gundam-printing-format-us-second",
    "gundam-printing-format-us-second",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  expect(requiredFirst(us.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approve(us.document);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const exported = await exportComponentRecords(revisionId, "printings");
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: "gundam@1",
        attributes: { alternate_art: false },
      },
    }),
  );
});

test("historical Gundam authority survives complete disappearance in both locale orders", async () => {
  const asiaOptions = {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@1",
  } as const;
  const usOptions = {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@1",
  } as const;

  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-first",
    "historical-authority-asia-first",
    asiaOptions,
  );
  const asia = await reconcile(asiaRun.id);
  const cardId = requiredString(requiredFirst(asia.document, "cards"), "id");
  const printingId = requiredString(
    requiredFirst(asia.document, "printings"),
    "id",
  );
  await approve(asia.document);

  const asiaMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-asia-missing",
    asiaOptions,
  );
  const asiaMissing = await reconcile(asiaMissingRun.id);
  await approve(asiaMissing.document);
  const missingPrinting = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(missingPrinting.document).toMatchObject({
    lifecycle: { withdrawn: false },
    locators: {
      historical: [
        expect.objectContaining({
          source_lineage: "gundam-en-asia",
          current: false,
        }),
      ],
    },
  });

  const usEquivalentRun = await collect(
    "/reconciliation/gundam-printing-format-us-second",
    "historical-authority-us-equivalent",
    usOptions,
  );
  const usEquivalent = await reconcile(usEquivalentRun.id);
  expect(requiredFirst(usEquivalent.document, "cards")).toMatchObject({
    id: cardId,
    name: "Printing authority",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "Official effect" },
    },
  });
  expect(requiredFirst(usEquivalent.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const usEquivalentPublished = await approve(usEquivalent.document);
  const usEquivalentRevision = requiredString(
    usEquivalentPublished.document,
    "resulting_revision_id",
  );
  expect(
    await exportComponentRecords(usEquivalentRevision, "cards"),
  ).toContainEqual(
    expect.objectContaining({
      id: cardId,
      name: "Printing authority",
      effective_rules_text: "Official effective rules",
    }),
  );
  expect(
    await exportComponentRecords(usEquivalentRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
    }),
  );
  const corroborated = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(corroborated.document.locators).toMatchObject({
    current: [
      expect.objectContaining({ source_lineage: "gundam-en-us" }),
    ],
    historical: [
      expect.objectContaining({ source_lineage: "gundam-en-asia" }),
    ],
  });

  const usConflictRun = await collect(
    "/reconciliation/gundam-printing-disappearance-us-conflict",
    "historical-authority-us-conflict",
    usOptions,
  );
  const usConflict = await reconcile(usConflictRun.id);
  expect(usConflict.response.status).toBe(409);
  expect(usConflict.document.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "canonical_card_conflict" }),
    ]),
  );
  const usPrintingConflictRun = await collect(
    "/reconciliation/gundam-printing-disappearance-us-printing-conflict",
    "historical-authority-us-printing-conflict",
    usOptions,
  );
  const usPrintingConflict = await reconcile(usPrintingConflictRun.id);
  expect(usPrintingConflict.response.status).toBe(409);
  expect(usPrintingConflict.document.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "printing_match_contradictory",
        candidate_printing_ids: [printingId],
      }),
    ]),
  );

  const usFirstRun = await collect(
    "/reconciliation/gundam-printing-format-us-first",
    "historical-authority-us-first",
    usOptions,
  );
  const usFirst = await reconcile(usFirstRun.id);
  const reverseCardId = requiredString(
    requiredFirst(usFirst.document, "cards"),
    "id",
  );
  const reversePrintingId = requiredString(
    requiredFirst(usFirst.document, "printings"),
    "id",
  );
  await approve(usFirst.document);
  const usMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-us-missing",
    usOptions,
  );
  const usMissing = await reconcile(usMissingRun.id);
  await approve(usMissing.document);
  const asiaEquivalentRun = await collect(
    "/reconciliation/gundam-printing-format-asia-second",
    "historical-authority-asia-equivalent",
    asiaOptions,
  );
  const asiaEquivalent = await reconcile(asiaEquivalentRun.id);
  expect(requiredFirst(asiaEquivalent.document, "cards")).toMatchObject({
    id: reverseCardId,
    name: "Printing authority",
    effective_rules_text: "Official effective rules",
    game_data: {
      profile: "gundam@1",
      attributes: { effect_text: "Official effect" },
    },
  });
  expect(requiredFirst(asiaEquivalent.document, "printings")).toMatchObject({
    id: reversePrintingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
  });
  await approve(asiaEquivalent.document);

  const reverseConflictUsRun = await collect(
    "/reconciliation/gundam-printing-conflict-us-first",
    "historical-authority-conflict-us-first",
    usOptions,
  );
  const reverseConflictUs = await reconcile(reverseConflictUsRun.id);
  await approve(reverseConflictUs.document);
  const reverseConflictMissingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "historical-authority-conflict-us-missing",
    usOptions,
  );
  const reverseConflictMissing = await reconcile(
    reverseConflictMissingRun.id,
  );
  await approve(reverseConflictMissing.document);
  const reverseConflictAsiaRun = await collect(
    "/reconciliation/gundam-printing-disappearance-asia-conflict",
    "historical-authority-conflict-asia-second",
    asiaOptions,
  );
  const reverseConflictAsia = await reconcile(reverseConflictAsiaRun.id);
  expect(reverseConflictAsia.response.status).toBe(409);
  expect(reverseConflictAsia.document.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "canonical_card_conflict" }),
    ]),
  );
}, 45_000);

test("Gundam EN-ASIA Printing facts become canonical when formatting-equivalent EN-US evidence arrived first", async () => {
  const usRun = await collect(
    "/reconciliation/gundam-printing-format-us-first",
    "gundam-printing-format-us-first",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  const printingId = requiredString(
    requiredFirst(us.document, "printings"),
    "id",
  );
  await approve(us.document);

  const asiaRun = await collect(
    "/reconciliation/gundam-printing-format-asia-second",
    "gundam-printing-format-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  expect(requiredFirst(asia.document, "printings")).toMatchObject({
    id: printingId,
    rarity: { raw: "L", normalized: "leader" },
    printed_rules_text: "Official printed rules",
    game_data: {
      profile: "gundam@1",
      attributes: { alternate_art: false },
    },
  });
  const published = await approve(asia.document);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const exported = await exportComponentRecords(revisionId, "printings");
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: printingId,
      rarity: { raw: "L", normalized: "leader" },
      printed_rules_text: "Official printed rules",
      game_data: {
        profile: "gundam@1",
        attributes: { alternate_art: false },
      },
    }),
  );
});

test("Gundam substantive Printing fact conflicts outside the identity tuple block in both locale orders", async () => {
  for (const sequence of [
    {
      firstScenario: "gundam-printing-conflict-asia-first",
      firstLineage: "gundam-en-asia",
      firstAdapter: "fixture-gundam-en-asia-json@1",
      secondScenario: "gundam-printing-conflict-us-second",
      secondLineage: "gundam-en-us",
      secondAdapter: "fixture-gundam-en-us-json@1",
    },
    {
      firstScenario: "gundam-printing-conflict-us-first",
      firstLineage: "gundam-en-us",
      firstAdapter: "fixture-gundam-en-us-json@1",
      secondScenario: "gundam-printing-conflict-asia-second",
      secondLineage: "gundam-en-asia",
      secondAdapter: "fixture-gundam-en-asia-json@1",
    },
  ] as const) {
    const firstRun = await collect(
      `/reconciliation/${sequence.firstScenario}`,
      sequence.firstScenario,
      {
        game: "gundam",
        lineage: sequence.firstLineage,
        adapter: sequence.firstAdapter,
      },
    );
    const first = await reconcile(firstRun.id);
    const printingId = requiredString(
      requiredFirst(first.document, "printings"),
      "id",
    );
    await approve(first.document);

    const secondRun = await collect(
      `/reconciliation/${sequence.secondScenario}`,
      sequence.secondScenario,
      {
        game: "gundam",
        lineage: sequence.secondLineage,
        adapter: sequence.secondAdapter,
      },
    );
    const second = await reconcile(secondRun.id);
    expect(second.response.status).toBe(409);
    expect(second.document).toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "printing_match_contradictory",
          candidate_printing_ids: [printingId],
          detail:
            "The retained Printing facts conflict across Gundam English " +
            "source lineages; EN-ASIA precedence cannot erase a substantive " +
            "EN-US disagreement.",
        }),
      ],
    });
  }
}, 15_000);

test("Gundam cross-locale formatting normalizes while substantive shared-fact conflicts block in both orders", async () => {
  const usRun = await collect(
    "/reconciliation/gundam-authority-us",
    "reconcile-gundam-authority-us-first",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const us = await reconcile(usRun.id);
  await approve(us.document);

  const asiaRun = await collect(
    "/reconciliation/gundam-authority-asia",
    "reconcile-gundam-authority-asia-second",
    {
      game: "gundam",
      lineage: "gundam-en-asia",
      adapter: "fixture-gundam-en-asia-json@1",
    },
  );
  const asia = await reconcile(asiaRun.id);
  expect(asia.response.status).toBe(200);
  expect(requiredFirst(asia.document, "cards")).toMatchObject({
    id: requiredString(requiredFirst(us.document, "cards"), "id"),
    name: "Formatting equivalent name",
  });
  await approve(asia.document);

  const laterUsRun = await collect(
    "/reconciliation/gundam-authority-us-conflict",
    "reconcile-gundam-authority-us-conflict",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const laterUs = await reconcile(laterUsRun.id);
  expect(laterUs.response.status).toBe(409);
  expect(laterUs.document).toMatchObject({
    diagnostics: [
      expect.objectContaining({ code: "canonical_card_conflict" }),
    ],
  });

  for (const sequence of [
    [
      "gundam-conflict-us-first",
      "gundam-en-us",
      "fixture-gundam-en-us-json@1",
      "gundam-conflict-asia-second",
      "gundam-en-asia",
      "fixture-gundam-en-asia-json@1",
    ],
    [
      "gundam-conflict-asia-first",
      "gundam-en-asia",
      "fixture-gundam-en-asia-json@1",
      "gundam-conflict-us-second",
      "gundam-en-us",
      "fixture-gundam-en-us-json@1",
    ],
  ] as const) {
    const [firstScenario, firstLineage, firstAdapter, secondScenario, secondLineage, secondAdapter] =
      sequence;
    const firstRun = await collect(
      `/reconciliation/${firstScenario}`,
      `reconcile-${firstScenario}`,
      {
        game: "gundam",
        lineage: firstLineage,
        adapter: firstAdapter,
      },
    );
    const first = await reconcile(firstRun.id);
    expect(first.response.status).toBe(200);
    await approve(first.document);

    const secondRun = await collect(
      `/reconciliation/${secondScenario}`,
      `reconcile-${secondScenario}`,
      {
        game: "gundam",
        lineage: secondLineage,
        adapter: secondAdapter,
      },
    );
    const second = await reconcile(secondRun.id);
    expect(second.response.status).toBe(409);
    expect(second.document).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "canonical_card_conflict" }),
      ],
    });
  }
}, 30_000);

test("fresh provenance changes the approval digest but records semantic no-change", async () => {
  const firstRun = await collect(
    "/reconciliation/repeatable",
    "reconcile-repeatable-first",
  );
  const first = await reconcile(firstRun.id);
  const firstPublished = await approve(first.document);
  const revisionId = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );

  const secondRun = await collect(
    "/reconciliation/repeatable",
    "reconcile-repeatable-second",
  );
  const second = await reconcile(secondRun.id);
  expect(second.document.candidate_digest).not.toBe(
    first.document.candidate_digest,
  );
  const secondPublished = await approve(second.document);
  expect(secondPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
});

test("locator and SourceBucket evidence refresh without minting Catalogue Revisions or exports", async () => {
  const baseRun = await collect(
    "/reconciliation/semantic-evidence-base",
    "reconcile-semantic-evidence-base",
  );
  const base = await reconcile(baseRun.id);
  const printingId = requiredString(
    requiredFirst(base.document, "printings"),
    "id",
  );
  const basePublished = await approve(base.document);
  const revisionId = requiredString(
    basePublished.document,
    "resulting_revision_id",
  );
  const exportIdentity = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key, manifest_digest
     FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string; manifest_digest: string }>();
  const revisionCount = await testEnv.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_revisions",
  ).first<{ count: number }>();

  const locatorRun = await collect(
    "/reconciliation/semantic-evidence-locator",
    "reconcile-semantic-evidence-locator",
  );
  const locator = await reconcile(locatorRun.id);
  expect(locator.document.candidate_digest).not.toBe(
    base.document.candidate_digest,
  );
  const locatorDigests = await testEnv.CATALOGUE_DB.prepare(
    `SELECT run.candidate_catalogue_digest, revision.content_digest
     FROM ingestion_runs AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`,
  )
    .bind(revisionId, locatorRun.id)
    .first<{
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(locatorDigests?.candidate_catalogue_digest).toBe(
    locatorDigests?.content_digest,
  );
  const locatorPublished = await approve(locator.document);
  expect(locatorPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const retainedLocator = await testEnv.CATALOGUE_DB.prepare(
    `SELECT last_observed_revision_id, current
     FROM reconciled_printing_locators
     WHERE printing_id = ? AND locator = '/official/evidence/relocated'`,
  )
    .bind(printingId)
    .first<{
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(retainedLocator).toMatchObject({
    last_observed_revision_id: revisionId,
    current: 1,
  });
  const retainedLocatorPlan = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_observation_id
     FROM reconciliation_candidates
     WHERE ingestion_run_id = ?
       AND printing_id = ?
       AND locator = '/official/evidence/relocated'`,
  )
    .bind(locatorRun.id, printingId)
    .first<{ source_observation_id: string }>();
  expect(retainedLocatorPlan?.source_observation_id).toMatch(
    /^srcobs_/,
  );

  const sourceBucketRun = await collect(
    "/reconciliation/semantic-evidence-source-bucket",
    "reconcile-semantic-evidence-source-bucket",
  );
  const sourceBucket = await reconcile(sourceBucketRun.id);
  expect(sourceBucket.document.candidate_digest).not.toBe(
    locator.document.candidate_digest,
  );
  const sourceBucketDigests = await testEnv.CATALOGUE_DB.prepare(
    `SELECT run.candidate_catalogue_digest, revision.content_digest
     FROM ingestion_runs AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`,
  )
    .bind(revisionId, sourceBucketRun.id)
    .first<{
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(sourceBucketDigests?.candidate_catalogue_digest).toBe(
    sourceBucketDigests?.content_digest,
  );
  const sourceBucketPublished = await approve(sourceBucket.document);
  expect(sourceBucketPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const retainedBucket = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_observation_id, last_observed_revision_id, current
     FROM reconciled_printing_memberships
     WHERE printing_id = ?
       AND relationship_kind = 'source_bucket'
       AND relationship_value = 'secondary-card-list'`,
  )
    .bind(printingId)
    .first<{
      source_observation_id: string;
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(retainedBucket).toMatchObject({
    source_observation_id: expect.stringMatching(/^srcobs_/),
    last_observed_revision_id: revisionId,
    current: 1,
  });
  const lifecycle = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(lifecycle.document).toMatchObject({
    locators: {
      current: [
        expect.objectContaining({
          locator: "/official/evidence/relocated",
          current: true,
        }),
      ],
      historical: [
        expect.objectContaining({
          locator: "/official/evidence/base",
          current: false,
        }),
      ],
    },
    memberships: {
      current: {
        source_buckets: ["secondary-card-list"],
      },
      historical: {
        source_buckets: [
          expect.objectContaining({
            id: "primary-card-list",
            current: false,
            last_missing_revision_id: revisionId,
          }),
        ],
      },
    },
  });
  expect(
    JSON.stringify(lifecycle.document.relationship_evidence),
  ).not.toContain("source_bucket");
  const afterRevisionCount = await testEnv.CATALOGUE_DB.prepare(
    "SELECT COUNT(*) AS count FROM catalogue_revisions",
  ).first<{ count: number }>();
  const afterExportIdentity = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key, manifest_digest
     FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string; manifest_digest: string }>();
  expect(afterRevisionCount).toEqual(revisionCount);
  expect(afterExportIdentity).toEqual(exportIdentity);
});

test("reversed retained observation provenance preserves the semantic relationship result", async () => {
  const forwardRun = await collect(
    "/reconciliation/deterministic-forward",
    "reconcile-deterministic-forward",
  );
  const forward = await reconcile(forwardRun.id);
  const published = await approve(forward.document);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );

  const reverseRun = await collect(
    "/reconciliation/deterministic-reverse",
    "reconcile-deterministic-reverse",
  );
  const reverse = await reconcile(reverseRun.id);
  expect(reverse.document.candidate_digest).not.toBe(
    forward.document.candidate_digest,
  );
  const repeated = await approve(reverse.document);
  expect(repeated.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
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

test("same-lineage authoritative Card evolution updates canonical facts while preserving identity", async () => {
  const firstRun = await collect(
    "/reconciliation/canonical-base",
    "reconcile-canonical-base",
  );
  const first = await reconcile(firstRun.id);
  const cardId = requiredString(requiredFirst(first.document, "cards"), "id");
  await approve(first.document);

  const changedRun = await collect(
    "/reconciliation/canonical-name-conflict",
    "reconcile-canonical-name-conflict",
  );
  const changed = await reconcile(changedRun.id);
  expect(changed.response.status).toBe(200);
  expect(requiredFirst(changed.document, "cards")).toMatchObject({
    id: cardId,
    name: "Unsupported replacement name",
  });
  await approve(changed.document);
  const history = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_lineage, canonical_facts_json, current
     FROM reconciled_card_observations
     WHERE card_id = ?
     ORDER BY catalogue_revision_id`,
  )
    .bind(cardId)
    .all<{
      source_lineage: string;
      canonical_facts_json: string;
      current: number;
    }>();
  expect(history.results).toHaveLength(2);
  expect(history.results.map(({ current }) => current).sort()).toEqual([0, 1]);
});

test("sequential selected-game publications retain the complete current catalogue across D1 and export", async () => {
  const onePieceRun = await collect(
    "/reconciliation/base",
    "reconcile-union-one-piece",
  );
  const onePiece = await reconcile(onePieceRun.id);
  const onePieceCard = requiredFirst(onePiece.document, "cards");
  const onePiecePrinting = requiredFirst(onePiece.document, "printings");
  const onePiecePublished = await approve(onePiece.document);
  expect(onePiecePublished.response.status).toBe(200);
  const onePieceRevision = requiredString(
    onePiecePublished.document,
    "resulting_revision_id",
  );
  const firstManifest = await exportManifest(onePieceRevision);

  const fusionRun = await collect(
    "/reconciliation/union-fusion-world",
    "reconcile-union-fusion-world",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const fusion = await reconcile(fusionRun.id);
  expect(fusion.response.status).toBe(200);
  const candidate = await get(
    `/v1/ingestion-runs/${fusionRun.id}/candidate`,
  );
  expect(candidate.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 1,
        printings_added: 1,
      },
    },
  });
  const published = await approve(fusion.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const profiles = await exportComponentRecords(
    revisionId,
    "game-profiles",
  );
  expect(profiles).toContainEqual(
    expect.objectContaining({
      profile: "fusion-world@1",
      schema: expect.objectContaining({
        additionalProperties: false,
        required: ["card", "printing"],
        properties: expect.objectContaining({
          card: expect.objectContaining({
            additionalProperties: false,
            required: expect.arrayContaining([
              "card_type",
              "specified_cost",
            ]),
          }),
        }),
      }),
    }),
  );

  const d1Cards = await testEnv.CATALOGUE_DB.prepare(
    "SELECT card_id FROM revision_cards WHERE catalogue_revision_id = ? ORDER BY card_id",
  )
    .bind(revisionId)
    .all<{ card_id: string }>();
  expect(d1Cards.results.length).toBeGreaterThanOrEqual(2);
  expect(d1Cards.results.map(({ card_id }) => card_id)).toContain(
    requiredString(onePieceCard, "id"),
  );
  const d1Printings = await testEnv.CATALOGUE_DB.prepare(
    "SELECT printing_id FROM revision_printings WHERE catalogue_revision_id = ? ORDER BY printing_id",
  )
    .bind(revisionId)
    .all<{ printing_id: string }>();
  expect(d1Printings.results.map(({ printing_id }) => printing_id)).toContain(
    requiredString(onePiecePrinting, "id"),
  );
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(
    d1Cards.results.length,
  );
  const fusionSnapshot = await testEnv.CATALOGUE_DB.prepare(
    `SELECT retrieved_at
     FROM source_snapshots
     WHERE ingestion_run_id = ?`,
  )
    .bind(fusionRun.id)
    .first<{ retrieved_at: string }>();
  const secondManifest = await exportManifest(revisionId);
  expect(secondManifest.source_freshness).toEqual(
    expect.arrayContaining([
      {
        game: "one-piece",
        area: "cards-and-printings",
        checked_at: firstManifest.source_freshness.find(
          ({ game }) => game === "one-piece",
        )?.checked_at,
      },
      {
        game: "fusion-world",
        area: "cards-and-printings",
        checked_at: fusionSnapshot?.retrieved_at,
      },
    ]),
  );
  const products = await exportComponentRecords(revisionId, "products");
  const sharedProducts = products.filter(
    (product) =>
      product.official_code === "product_op01" &&
      ["one-piece", "fusion-world"].includes(String(product.game)),
  );
  expect(sharedProducts).toHaveLength(2);
  expect(new Set(sharedProducts.map(({ id }) => id)).size).toBe(2);
  expect(sharedProducts.map(({ game }) => game).sort()).toEqual([
    "fusion-world",
    "one-piece",
  ]);
  const relationships = await exportComponentRecords(
    revisionId,
    "relationships",
  );
  expect(relationships.every(({ id }) =>
    /^relationship_[a-f0-9]{64}$/.test(String(id)),
  )).toBe(true);
  const sharedProductIds = new Set(sharedProducts.map(({ id }) => id));
  const productTargets = relationships
    .filter(
      ({ relationship_value, to }) =>
        relationship_value === "product_op01" &&
        sharedProductIds.has((to as Record<string, unknown>).id),
    )
    .map(({ to }) => (to as Record<string, unknown>).id);
  expect(new Set(productTargets).size).toBe(2);

  const refreshRun = await collect(
    "/reconciliation/base",
    "reconcile-union-one-piece-refresh",
  );
  const refresh = await reconcile(refreshRun.id);
  const retainedPlan = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_observation_id
     FROM reconciliation_candidates
     WHERE ingestion_run_id = ?
     ORDER BY source_observation_id
     LIMIT 1`,
  )
    .bind(refreshRun.id)
    .first<{ source_observation_id: string }>();
  const digests = await testEnv.CATALOGUE_DB.prepare(
    `SELECT run.candidate_digest, run.candidate_catalogue_digest,
            revision.content_digest
     FROM ingestion_runs AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`,
  )
    .bind(revisionId, refreshRun.id)
    .first<{
      candidate_digest: string;
      candidate_catalogue_digest: string;
      content_digest: string;
    }>();
  expect(digests?.candidate_digest).toBe(
    requiredString(refresh.document, "candidate_digest"),
  );
  expect(digests?.candidate_catalogue_digest).toBe(
    digests?.content_digest,
  );
  const refreshed = await approve(refresh.document);
  expect(refreshed.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const refreshedCardObservation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_observation_id, catalogue_revision_id, current
     FROM reconciled_card_observations
     WHERE card_id = ? AND source_lineage = 'one-piece-en' AND current = 1`,
  )
    .bind(requiredString(onePieceCard, "id"))
    .first<{
      source_observation_id: string;
      catalogue_revision_id: string;
      current: number;
    }>();
  expect(refreshedCardObservation).toEqual({
    source_observation_id: retainedPlan?.source_observation_id,
    catalogue_revision_id: revisionId,
    current: 1,
  });
  const refreshedMembership = await testEnv.CATALOGUE_DB.prepare(
    `SELECT source_observation_id, last_observed_revision_id, current
     FROM reconciled_printing_memberships
     WHERE printing_id = ?
       AND source_lineage = 'one-piece-en'
       AND relationship_kind = 'product'
       AND relationship_value = 'product_op01'
       AND current = 1`,
  )
    .bind(requiredString(onePiecePrinting, "id"))
    .first<{
      source_observation_id: string;
      last_observed_revision_id: string;
      current: number;
    }>();
  expect(refreshedMembership).toEqual({
    source_observation_id: retainedPlan?.source_observation_id,
    last_observed_revision_id: revisionId,
    current: 1,
  });
});

test("candidate inspection reports stable reconciliation matches rather than every entity as added", async () => {
  const firstRun = await collect(
    "/reconciliation/base",
    "reconcile-inspection-base",
  );
  const first = await reconcile(firstRun.id);
  const firstCard = requiredFirst(first.document, "cards");
  const firstPrinting = requiredFirst(first.document, "printings");
  await approve(first.document);

  const nextRun = await collect(
    "/reconciliation/new-locator",
    "reconcile-inspection-new-locator",
  );
  const next = await reconcile(nextRun.id);
  const inspected = await get(
    `/v1/ingestion-runs/${nextRun.id}/candidate`,
  );
  expect(inspected.response.status).toBe(200);
  const inspectedWarnings = (
    inspected.document.diff as Record<string, unknown>
  ).warnings as Record<string, unknown>[];
  expect(inspectedWarnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "relationship_not_observed",
        printing_id: requiredString(firstPrinting, "id"),
      }),
    ]),
  );
  expect(inspected.document).toMatchObject({
    diff: {
      summary: {
        cards_added: 0,
        printings_added: 0,
      },
      cards: {
        added: [],
        changed: [],
        missing_observations: expect.not.arrayContaining([
          requiredString(firstCard, "id"),
        ]),
      },
      printings: {
        added: [],
        changed: [],
        identity_matches: [requiredString(firstPrinting, "id")],
      },
    },
  });
  await post(`/v1/ingestion-runs/${nextRun.id}/rejection`, {
    candidate_digest: requiredString(next.document, "candidate_digest"),
    idempotency_key: "reject-inspected-candidate",
  });
});

test("generic retry rejects an evidence-backed terminal run so reconciliation provenance cannot be reset", async () => {
  const run = await collect(
    "/reconciliation/base",
    "reconcile-generic-retry",
  );
  const reconciled = await reconcile(run.id);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(
      reconciled.document,
      "candidate_digest",
    ),
    idempotency_key: "reject-before-generic-retry",
  });

  const retried = await post(`/v1/ingestion-runs/${run.id}/retry`, {
    idempotency_key: "generic-retry-must-not-reset-evidence",
  });
  expect(retried.response.status).toBe(409);
  expect(retried.document).toMatchObject({
    code: "evidence_retry_required",
  });
  const original = await get(`/v1/ingestion-runs/${run.id}`);
  expect(original.document).toMatchObject({
    state: "rejected",
  });
  const retainedCandidate = await testEnv.CATALOGUE_DB.prepare(
    `SELECT candidate.candidate_digest,
            (
              SELECT group_concat(content, '')
              FROM (
                SELECT content
                FROM reconciliation_payload_chunks
                WHERE ingestion_run_id = candidate.id
                  AND payload_kind = 'digest'
                ORDER BY chunk_index
              )
            ) AS digest_payload_json
     FROM ingestion_runs AS candidate
     WHERE candidate.id = ?
     LIMIT 1`,
  )
    .bind(run.id)
    .first<{
      candidate_digest: string;
      digest_payload_json: string;
    }>();
  expect(retainedCandidate).toMatchObject({
    candidate_digest: requiredString(
      reconciled.document,
      "candidate_digest",
    ),
  });
  expect(retainedCandidate?.digest_payload_json).toContain(
    '"catalogue_data"',
  );
  const interveningDocument = await injectFixturePublication(
    testEnv.CATALOGUE_DB,
    testEnv.CATALOGUE_EXPORTS,
    {
      fixture: "first-catalogue",
      selected_games: ["one-piece"],
      idempotency_key: "intervening-current-revision",
    },
  );
  const intervening = {
    response: new Response(null, { status: 201 }),
    document: interveningDocument,
  };
  expect(intervening.response.status).toBe(201);
  const interveningPublished = await post(
    `/v1/ingestion-runs/${requiredString(intervening.document, "id")}/approval`,
    {
      candidate_digest: requiredString(
        intervening.document,
        "candidate_digest",
      ),
      expected_current_revision_id: requiredString(
        intervening.document,
        "expected_current_revision_id",
      ),
      idempotency_key: "approve-intervening-current-revision",
    },
  );
  expect(interveningPublished.response.status).toBe(200);
  const currentRevision = requiredString(
    interveningPublished.document,
    "resulting_revision_id",
  );
  const evidenceRetry = await post(
    `/v1/ingestion-runs/${run.id}/collection/retry`,
    { idempotency_key: "linked-retry-retains-evidence-plan" },
  );
  expect(evidenceRetry.response.status).toBe(201);
  expect(evidenceRetry.document).toMatchObject({
    state: "collecting",
    linked_run_id: run.id,
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    plan_origin: "synthetic_fixture",
    expected_current_revision_id: currentRevision,
  });
  const retryId = requiredString(evidenceRetry.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${retryId}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  await waitForRunState(retryId, "parsing");
  const retryCandidate = await reconcile(retryId);
  const rejected = await post(`/v1/ingestion-runs/${retryId}/rejection`, {
    candidate_digest: requiredString(
      retryCandidate.document,
      "candidate_digest",
    ),
    idempotency_key: "reject-linked-retry-after-verification",
  });
  expect(rejected.response.status).toBe(200);
}, 30_000);

test("historical locator bindings reactivate only for the same Printing and expose lifecycle evidence", async () => {
  const baseRun = await collect(
    "/reconciliation/locator-binding-base",
    "locator-binding-base",
  );
  const base = await reconcile(baseRun.id);
  const printingId = requiredString(
    requiredFirst(base.document, "printings"),
    "id",
  );
  const basePublished = await approve(base.document);
  const firstRevision = requiredString(
    basePublished.document,
    "resulting_revision_id",
  );

  const missingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "locator-binding-missing-first",
  );
  const missing = await reconcile(missingRun.id);
  const missingPublished = await approve(missing.document);
  const missingRevision = requiredString(
    missingPublished.document,
    "resulting_revision_id",
  );
  const stale = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(stale.document).toMatchObject({
    locators: {
      current: [],
      historical: [
        {
          locator: "/official/locator-binding/stable",
          source_lineage: "one-piece-en",
          variant_key: null,
          first_revision_id: firstRevision,
          last_observed_revision_id: firstRevision,
          current: false,
          last_missing_revision_id: missingRevision,
        },
      ],
    },
  });
  expect(
    await exportComponentRecords(missingRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: printingId,
      locator_evidence: stale.document.locators,
    }),
  );

  const compatibleRun = await collect(
    "/reconciliation/locator-binding-compatible",
    "locator-binding-compatible-return",
  );
  const compatible = await reconcile(compatibleRun.id);
  expect(requiredFirst(compatible.document, "printings")).toMatchObject({
    id: printingId,
  });
  const compatiblePublished = await approve(compatible.document);
  const reactivatedRevision = requiredString(
    compatiblePublished.document,
    "resulting_revision_id",
  );
  const reactivated = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(reactivated.document).toMatchObject({
    locators: {
      current: [
        {
          locator: "/official/locator-binding/stable",
          source_lineage: "one-piece-en",
          variant_key: null,
          first_revision_id: firstRevision,
          last_observed_revision_id: reactivatedRevision,
          current: true,
          last_missing_revision_id: null,
        },
      ],
      historical: [],
    },
  });

  const missingAgainRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "locator-binding-missing-second",
  );
  const missingAgain = await reconcile(missingAgainRun.id);
  const missingAgainPublished = await approve(missingAgain.document);
  const missingAgainRevision = requiredString(
    missingAgainPublished.document,
    "resulting_revision_id",
  );
  const incompatibleRun = await collect(
    "/reconciliation/locator-binding-incompatible",
    "locator-binding-incompatible-return",
  );
  const incompatible = await reconcile(incompatibleRun.id);
  expect(incompatible.response.status).toBe(409);
  expect(incompatible.document).toMatchObject({
    diagnostics: [
      {
        code: "printing_match_contradictory",
        locator: "/official/locator-binding/stable",
        candidate_printing_ids: [printingId],
        detail: expect.stringContaining(
          "retained locator contradicts",
        ),
      },
    ],
  });
  const retainedBinding = await testEnv.CATALOGUE_DB.prepare(
    `SELECT printing_id, current, last_missing_revision_id
     FROM reconciled_printing_locators
     WHERE source_lineage = 'one-piece-en'
       AND locator = '/official/locator-binding/stable'`,
  ).first<{
    printing_id: string;
    current: number;
    last_missing_revision_id: string;
  }>();
  expect(retainedBinding).toEqual({
    printing_id: printingId,
    current: 0,
    last_missing_revision_id: missingAgainRevision,
  });
  expect(
    await exportComponentRecords(missingAgainRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: printingId,
      locator_evidence: {
        current: [],
        historical: [
          expect.objectContaining({
            locator: "/official/locator-binding/stable",
            current: false,
            last_missing_revision_id: missingAgainRevision,
          }),
        ],
      },
    }),
  );
}, 30_000);

test("locator variant evolution preserves effective-dated suffix history across disappearance and reactivation", async () => {
  const firstRun = await collect(
    "/reconciliation/locator-variant-v1",
    "locator-variant-v1",
  );
  const first = await reconcile(firstRun.id);
  const printingId = requiredString(
    requiredFirst(first.document, "printings"),
    "id",
  );
  const firstRevision = requiredString(
    (await approve(first.document)).document,
    "resulting_revision_id",
  );
  const secondRun = await collect(
    "/reconciliation/locator-variant-v2",
    "locator-variant-v2",
  );
  const second = await reconcile(secondRun.id);
  expect(requiredFirst(second.document, "printings")).toMatchObject({
    id: printingId,
  });
  const secondRevision = requiredString(
    (await approve(second.document)).document,
    "resulting_revision_id",
  );
  const evolved = await get(`/v1/reconciliation/printings/${printingId}`);
  expect(evolved.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        locator: "/official/locator-variant/stable",
        variant_key: "suffix-b",
        first_revision_id: secondRevision,
        current: true,
      }),
    ],
    historical: [
      expect.objectContaining({
        locator: "/official/locator-variant/stable",
        variant_key: "suffix-a",
        first_revision_id: firstRevision,
        last_observed_revision_id: firstRevision,
        current: false,
        last_missing_revision_id: secondRevision,
      }),
    ],
  });
  const missingRun = await collect(
    "/reconciliation/complete-empty-lineage",
    "locator-variant-missing",
  );
  const missing = await reconcile(missingRun.id);
  const missingRevision = requiredString(
    (await approve(missing.document)).document,
    "resulting_revision_id",
  );
  const reactivatedRun = await collect(
    "/reconciliation/locator-variant-v1",
    "locator-variant-reactivate-v1",
  );
  const reactivated = await reconcile(reactivatedRun.id);
  const reactivatedRevision = requiredString(
    (await approve(reactivated.document)).document,
    "resulting_revision_id",
  );
  const lifecycle = await get(
    `/v1/reconciliation/printings/${printingId}`,
  );
  expect(lifecycle.document.locators).toMatchObject({
    current: [
      expect.objectContaining({
        variant_key: "suffix-a",
        first_revision_id: firstRevision,
        last_observed_revision_id: reactivatedRevision,
        last_missing_revision_id: null,
      }),
    ],
    historical: [
      expect.objectContaining({
        variant_key: "suffix-b",
        first_revision_id: secondRevision,
        last_observed_revision_id: secondRevision,
        current: false,
        last_missing_revision_id: missingRevision,
      }),
    ],
  });
  expect(
    await exportComponentRecords(reactivatedRevision, "printings"),
  ).toContainEqual(
    expect.objectContaining({
      id: printingId,
      locator_evidence: lifecycle.document.locators,
    }),
  );
}, 20_000);

test("Card search keeps exactly the current and two preceding distinct Catalogue Revisions hot", async () => {
  const status = await get("/v1/status");
  const baselineRevision = requiredString(
    requiredRecord(status.document.safe_state, "safe_state"),
    "current_revision_id",
  );
  const revisions: string[] = [];
  let retainedDocumentCount: number | null = null;
  for (const [index, scenario] of [
    "query-hot-window-1",
    "query-hot-window-2",
    "query-hot-window-3",
    "query-hot-window-4",
  ].entries()) {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `query-hot-window-${index + 1}-${scenario}`,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const revisionId = requiredString(
      (await approve(reconciled.document)).document,
      "resulting_revision_id",
    );
    expect(revisions).not.toContain(revisionId);
    revisions.push(revisionId);
    if (retainedDocumentCount === null) {
      retainedDocumentCount = (
        await testEnv.CATALOGUE_DB.prepare(
          `SELECT COUNT(*) AS count
           FROM revision_card_query_documents
           WHERE catalogue_revision_id = ?`,
        )
          .bind(revisionId)
          .first<{ count: number }>()
      )?.count ?? null;
    }
  }
  const [first, second, third, current] = revisions as [
    string,
    string,
    string,
    string,
  ];
  expect(retainedDocumentCount).not.toBeNull();
  const chain = await testEnv.CATALOGUE_DB.prepare(
    `SELECT revision.id, revision.expected_previous_revision_id,
            state.current_revision_id
     FROM catalogue_revisions AS revision
     CROSS JOIN catalogue_state AS state
     WHERE revision.id IN (?, ?, ?, ?)`,
  )
    .bind(first, second, third, current)
    .all<{
      id: string;
      expected_previous_revision_id: string;
      current_revision_id: string;
    }>();
  expect(chain.results).toHaveLength(4);
  expect(
    new Map(
      chain.results.map((revision) => [
        revision.id,
        revision.expected_previous_revision_id,
      ]),
    ),
  ).toEqual(
    new Map([
      [first, baselineRevision],
      [second, first],
      [third, second],
      [current, third],
    ]),
  );
  expect(
    new Set(
      chain.results.map(({ current_revision_id }) =>
        current_revision_id
      ),
    ),
  ).toEqual(new Set([current]));

  const queryStates = await testEnv.CATALOGUE_DB.prepare(
    `SELECT query.catalogue_revision_id, query.state,
            COUNT(document.card_id) AS document_count
     FROM catalogue_query_revisions AS query
     LEFT JOIN revision_card_query_documents AS document
       ON document.catalogue_revision_id =
            query.catalogue_revision_id
     WHERE query.catalogue_revision_id IN (?, ?, ?, ?)
     GROUP BY query.catalogue_revision_id, query.state`,
  )
    .bind(first, second, third, current)
    .all<{
      catalogue_revision_id: string;
      state: string;
      document_count: number;
    }>();
  expect(queryStates.results).toHaveLength(4);
  const queryStateByRevision = new Map(
    queryStates.results.map((row) => [
      row.catalogue_revision_id,
      { state: row.state, document_count: row.document_count },
    ]),
  );
  expect(queryStateByRevision.get(first)).toEqual({
    state: "archived",
    document_count: 0,
  });
  for (const retainedRevision of [second, third, current]) {
    expect(queryStateByRevision.get(retainedRevision)).toEqual({
      state: "available",
      document_count: retainedDocumentCount,
    });
  }
}, 30_000);

test("every planned request contributes exactly one provenance-bound observation set in deterministic request order", async () => {
  const run = await collectRequests(
    [
      { id: "partition-a", scenario: "base" },
      { id: "partition-b", scenario: "new-locator" },
    ],
    "multi-request-complete-coverage",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document.publishable).toBe(true);
  expect(requiredFirst(reconciled.document, "cards")).toMatchObject({
    name: "Monkey.D.Luffy",
  });
  expect(requiredFirst(reconciled.document, "printings")).toMatchObject({
    rarity: { normalized: "leader" },
  });
  const plans = await testEnv.CATALOGUE_DB.prepare(
    `SELECT request.request_id, candidate.source_snapshot_id,
            candidate.source_observation_set_id
     FROM reconciliation_candidates AS candidate
     JOIN source_snapshots AS snapshot
       ON snapshot.id = candidate.source_snapshot_id
     JOIN source_requests AS request
       ON request.ingestion_run_id = snapshot.ingestion_run_id
      AND request.source_snapshot_id = snapshot.id
     WHERE candidate.ingestion_run_id = ?
     ORDER BY request.sequence_number`,
  )
    .bind(run.id)
    .all<{
      request_id: string;
      source_snapshot_id: string;
      source_observation_set_id: string;
    }>();
  expect(plans.results.map((row) => row.request_id)).toEqual([
    "partition-a",
    "partition-b",
  ]);
  expect(new Set(plans.results.map((row) => row.source_snapshot_id)).size).toBe(
    2,
  );
  expect(
    new Set(plans.results.map((row) => row.source_observation_set_id)).size,
  ).toBe(2);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(reconciled.document, "candidate_digest"),
    idempotency_key: "reject-multi-request-complete-coverage",
  });
});

test("aggregate reconciliation size is rejected before any retained object is read", async () => {
  const run = await collectRequests(
    [
      { id: "aggregate-a", scenario: "base" },
      { id: "aggregate-b", scenario: "new-locator" },
      { id: "aggregate-c", scenario: "base" },
    ],
    "aggregate-budget-before-object-read",
  );
  const retained = await testEnv.CATALOGUE_DB.prepare(
    `SELECT observations.content_object_key
     FROM source_observation_sets AS observations
     JOIN source_snapshots AS snapshots
       ON snapshots.id = observations.source_snapshot_id
     WHERE snapshots.ingestion_run_id = ?
     ORDER BY snapshots.request_id`,
  ).bind(run.id).all<{ content_object_key: string }>();
  expect(retained.results).toHaveLength(3);
  await testEnv.CATALOGUE_DB.prepare(
    `DROP TRIGGER source_observation_sets_are_immutable_on_update`,
  ).run();
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE source_observation_sets
     SET content_byte_length = 12582912
     WHERE source_snapshot_id IN (
       SELECT id FROM source_snapshots WHERE ingestion_run_id = ?
     )`,
  ).bind(run.id).run();
  await testEnv.CATALOGUE_DB.prepare(
    `CREATE TRIGGER source_observation_sets_are_immutable_on_update
     BEFORE UPDATE ON source_observation_sets
     BEGIN
       SELECT RAISE(ABORT, 'immutable_source_observation_set');
     END`,
  ).run();
  await testEnv.EVIDENCE_OBJECTS.delete(
    retained.results[0]!.content_object_key,
  );

  const blocked = await reconcile(run.id);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [expect.objectContaining({
      code: "retained_evidence_invalid",
      detail: expect.stringContaining(
        "aggregate reconciliation byte budget",
      ),
    })],
  });
  expect(JSON.stringify(blocked.document)).not.toContain(
    "bytes are unavailable",
  );
});

test("empty first, middle, and last partitions remain durable and digest-bound", async () => {
  for (const emptyIndex of [0, 1, 2]) {
    const requests = ["base", "new-locator", "base"].map(
      (scenario, index) => ({
        id: `partition-${index}`,
        scenario:
          index === emptyIndex ? "complete-empty-lineage" : scenario,
      }),
    );
    const run = await collectRequests(
      requests,
      `durable-empty-partition-${emptyIndex}`,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const partitions = await testEnv.CATALOGUE_DB.prepare(
      `SELECT sequence_number, request_id, source_snapshot_id,
              source_observation_set_id
       FROM reconciliation_evidence_partitions
       WHERE ingestion_run_id = ?
       ORDER BY sequence_number`,
    )
      .bind(run.id)
      .all<{
        sequence_number: number;
        request_id: string;
        source_snapshot_id: string;
        source_observation_set_id: string;
      }>();
    expect(partitions.results.map(({ request_id }) => request_id)).toEqual(
      requests.map(({ id }) => id),
    );
    expect(
      partitions.results.every(
        (row) =>
          row.source_snapshot_id.startsWith("srcsnap_") &&
          row.source_observation_set_id.startsWith("srcobsset_"),
      ),
    ).toBe(true);
    const digest = await testEnv.CATALOGUE_DB.prepare(
      `SELECT group_concat(content, '') AS value
       FROM (
         SELECT content
         FROM reconciliation_payload_chunks
         WHERE ingestion_run_id = ? AND payload_kind = 'digest'
         ORDER BY chunk_index
       )`,
    )
      .bind(run.id)
      .first<{ value: string }>();
    expect(digest?.value).toContain('"evidence_partitions"');
    for (const request of requests) {
      expect(digest?.value).toContain(`"requestId":"${request.id}"`);
    }
    await post(`/v1/ingestion-runs/${run.id}/rejection`, {
      candidate_digest: requiredString(
        reconciled.document,
        "candidate_digest",
      ),
      idempotency_key: `reject-durable-empty-${emptyIndex}`,
    });
  }
}, 30_000);

test("unplanned requests fail at D1 while duplicate and unplanned observation sets fail reconciliation", async () => {
  const missing = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-missing-coverage",
  );
  await expect(
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests (
         ingestion_run_id, request_id, sequence_number, method, url,
         request_headers_json, representation_fingerprint, state
       ) VALUES (?, 'partition-missing', 1, 'GET',
         'https://official-source.invalid/reconciliation/new-locator',
         '{}', 'missing', 'pending')`,
    )
      .bind(missing.id)
      .run(),
  ).rejects.toThrow(/source_request_not_in_immutable_plan/);
  const exact = await reconcile(missing.id);
  expect(exact.response.status).toBe(200);
  await post(`/v1/ingestion-runs/${missing.id}/rejection`, {
    candidate_digest: requiredString(exact.document, "candidate_digest"),
    idempotency_key: "reject-exact-plan-after-unplanned-insert",
  });

  const duplicate = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-duplicate-set",
  );
  const duplicateSuffix = crypto.randomUUID();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, source_snapshot_id, adapter_version, 'collection', ?,
            ?, ?, parsed_at, 'finalized',
            content_digest, content_byte_length, observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) AND intent = 'collection'`,
  )
    .bind(
      `parse_${duplicateSuffix}`,
      `duplicate-${duplicateSuffix}`,
      `srcobsset_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, source_snapshot_id, source_lineage, supported_game,
            game_profile_version, adapter_version, parsed_at,
            content_digest, content_byte_length, ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) ORDER BY id LIMIT 1`,
  )
    .bind(
      `srcobsset_${duplicateSuffix}`,
      `parse_${duplicateSuffix}`,
      `source-observations/duplicate-${duplicateSuffix}.json`,
      duplicate.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(
    duplicate.id,
    "requires exactly one collection Source Observation Set",
  );

  const unplanned = await collectRequests(
    [{ id: "partition-a", scenario: "base" }],
    "multi-request-unplanned-set",
  );
  const rogue = crypto.randomUUID();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_fetch_attempts (
       id, ingestion_run_id, request_id, attempt_number, requested_at,
       completed_at, outcome, http_status, response_headers_json,
       retry_after_ms, diagnostic
     )
     SELECT ?, ingestion_run_id, request_id, 99, requested_at,
            completed_at, outcome, http_status, response_headers_json,
            retry_after_ms, diagnostic
     FROM source_fetch_attempts
     WHERE ingestion_run_id = ? ORDER BY attempt_number LIMIT 1`,
  )
    .bind(`fetch_${rogue}`, unplanned.id)
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_snapshots (
       id, ingestion_run_id, request_id, fetch_attempt_id, request_method,
       request_url, request_headers_json, representation_fingerprint,
       response_vary_json, retrieved_at, http_status, response_headers_json,
       media_type, content_digest, content_byte_length, content_object_key,
       source_lineage, supported_game, game_profile_version, adapter_version,
       reused_source_snapshot_id
     )
     SELECT ?, ingestion_run_id, request_id, ?, request_method,
            request_url, request_headers_json, representation_fingerprint,
            response_vary_json, retrieved_at, http_status,
            response_headers_json, media_type, content_digest,
            content_byte_length, content_object_key, source_lineage,
            supported_game, game_profile_version, adapter_version, NULL
     FROM source_snapshots
     WHERE id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     )`,
  )
    .bind(`snapshot_${rogue}`, `fetch_${rogue}`, unplanned.id)
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_parse_operations (
       id, source_snapshot_id, adapter_version, intent, idempotency_key,
       observation_set_id, content_object_key, parsed_at, state,
       content_digest, content_byte_length, observation_count
     )
     SELECT ?, ?, adapter_version, 'collection', ?, ?, ?, parsed_at,
            'finalized', content_digest, content_byte_length,
            observation_count
     FROM source_parse_operations
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) AND intent = 'collection'`,
  )
    .bind(
      `parse_${rogue}`,
      `snapshot_${rogue}`,
      `rogue-${rogue}`,
      `srcobsset_${rogue}`,
      `source-observations/rogue-${rogue}.json`,
      unplanned.id,
    )
    .run();
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO source_observation_sets (
       id, parse_operation_id, source_snapshot_id, source_lineage,
       supported_game, game_profile_version, adapter_version, parsed_at,
       content_digest, content_byte_length, content_object_key,
       observation_count
     )
     SELECT ?, ?, ?, source_lineage, supported_game, game_profile_version,
            adapter_version, parsed_at, content_digest, content_byte_length,
            ?, observation_count
     FROM source_observation_sets
     WHERE source_snapshot_id = (
       SELECT source_snapshot_id FROM source_requests
       WHERE ingestion_run_id = ? AND request_id = 'partition-a'
     ) ORDER BY id LIMIT 1`,
  )
    .bind(
      `srcobsset_${rogue}`,
      `parse_${rogue}`,
      `snapshot_${rogue}`,
      `source-observations/rogue-${rogue}.json`,
      unplanned.id,
    )
    .run();
  await expectRetainedEvidenceInvalid(
    unplanned.id,
    "Unplanned Source Observation Set",
  );
});

test("a 1001-entity reconciliation publishes atomically within bounded D1 statement budgets", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-cards",
    "bounded-d1-scale-1001-cards",
    undefined,
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.response.status).toBe(200);
  expect(
    Array.isArray(reconciled.document.cards)
      ? reconciled.document.cards
      : [],
  ).toHaveLength(1_001);
  const publicCardIds = (
    Array.isArray(reconciled.document.cards)
      ? reconciled.document.cards
      : []
  ).map((card) =>
    requiredString(card as Record<string, unknown>, "id")
  );
  expect(new Set(publicCardIds).size).toBe(1_001);
  if (!("workflow_instance_id" in reconciled)) {
    throw new Error("Expected an accepted reconciliation Workflow.");
  }
  const workflowInstance = await testEnv.RECONCILIATION_WORKFLOW.get(
    reconciled.workflow_instance_id,
  );
  const workflowStatus = await workflowInstance.status();
  expect(workflowStatus.status).toBe("complete");
  const durableOutputBytes = new TextEncoder().encode(
    JSON.stringify(workflowStatus.output),
  ).byteLength;
  expect(durableOutputBytes).toBeLessThan(1_048_576);
  expect(workflowStatus.output).toMatchObject({
    result_json: expect.stringContaining(
      "card-keepr-reconciliation-workflow-result@1",
    ),
  });
  const publicReplay = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation`,
    {
      expected_current_revision_id: requiredString(
        reconciled.document,
        "expected_current_revision_id",
      ),
      idempotency_key: `reconcile-${run.id}`,
    },
  );
  expect(publicReplay.response.status).toBe(200);
  expect(publicReplay.document.output).toEqual(reconciled.document);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const persisted = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM revision_cards
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ count: number }>();
  expect(persisted?.count).toBeGreaterThan(1_000);
  expect(await exportComponentRecords(revisionId, "cards")).toHaveLength(
    persisted?.count ?? 0,
  );
  const chunks = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count,
            MAX(length(CAST(content AS BLOB))) AS maximum_bytes,
            SUM(
              CASE WHEN payload_kind = 'candidate'
                THEN length(CAST(content AS BLOB))
                ELSE 0
              END
            ) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ?`,
  )
    .bind(run.id)
    .first<{
      count: number;
      maximum_bytes: number;
      candidate_bytes: number;
    }>();
  expect(chunks?.count).toBeGreaterThan(32);
  expect(chunks?.count).toBeLessThan(900);
  expect(chunks?.maximum_bytes).toBeLessThanOrEqual(524_288);
  expect(chunks?.candidate_bytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(chunks?.candidate_bytes).toBeLessThan(16 * 1024 * 1024);
  const searchMaterialization = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?
          AND card_id IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )) AS term_count,
       (SELECT MAX(length(term)) FROM revision_card_search_terms
        WHERE catalogue_revision_id = ?) AS maximum_term_length,
       (SELECT SUM(length(CAST(search_text AS BLOB)))
        FROM revision_card_search_chunks
        WHERE catalogue_revision_id = ?) AS chunk_bytes`,
  )
    .bind(
      revisionId,
      JSON.stringify(publicCardIds),
      revisionId,
      revisionId,
    )
    .first<{
      term_count: number;
      maximum_term_length: number;
      chunk_bytes: number;
    }>();
  expect(searchMaterialization?.term_count).toBeLessThanOrEqual(
    256 * 1_001,
  );
  expect(searchMaterialization?.maximum_term_length).toBeLessThanOrEqual(6);
  expect(searchMaterialization?.chunk_bytes).toBeLessThan(
    16 * 1024 * 1024,
  );
  const storedRun = await testEnv.CATALOGUE_DB.prepare(
    "SELECT candidate_json FROM ingestion_runs WHERE id = ?",
  )
    .bind(run.id)
    .first<{ candidate_json: string }>();
  expect(storedRun?.candidate_json).toContain(
    '"chunked_reconciliation_payload":"candidate"',
  );
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ?`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifest = await (
    await testEnv.CATALOGUE_EXPORTS.get(exportRow?.manifest_key ?? "")
  )?.json<{ components: { compressed_bytes: number }[] }>();
  expect(
    manifest?.components.reduce(
      (total, component) => total + component.compressed_bytes,
      0,
    ),
  ).toBeGreaterThan(1_048_576);
}, 180_000);

test("recovery health gates fixture evidence injection and reconciliation before mutation", async () => {
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedStart = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@2",
    idempotency_key: "blocked-recovery-start",
    requests: officialSourceDiscoveryRequests("one-piece-en"),
  });
  expect(blockedStart.response.status).toBe(409);
  expect(blockedStart.document).toMatchObject({
    code: "recovery_not_verified",
  });
  const blockedMutation = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ingestion_runs
        WHERE idempotency_key = 'blocked-recovery-start') AS runs,
       active_ingestion_run_id
     FROM operation_state
     WHERE singleton = 1`,
  ).first<{ runs: number; active_ingestion_run_id: string | null }>();
  expect(blockedMutation).toEqual({
    runs: 0,
    active_ingestion_run_id: null,
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const run = await collect(
    "/reconciliation/base",
    "blocked-recovery-reconciliation",
  );
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1",
  ).run();
  const blockedReconciliation = await reconcile(run.id);
  expect(blockedReconciliation.response.status).toBe(409);
  expect(blockedReconciliation.document).toMatchObject({
    code: "recovery_not_verified",
  });
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1",
  ).run();
  const resumed = await reconcile(run.id, {}, 45_000);
  await post(`/v1/ingestion-runs/${run.id}/rejection`, {
    candidate_digest: requiredString(resumed.document, "candidate_digest"),
    idempotency_key: "reject-after-recovery-restored",
  });
}, 60_000);

test("a partial Gundam refresh accepts one selected production lineage independently", async () => {
  const sourceLineage = "gundam-en-asia";
  const adapterVersion = "gundam-en-asia@3";
  const oneLocale = await post("/v1/ingestion-runs/evidence", {
    plans: [{
      supported_game: "gundam",
      source_lineage: sourceLineage,
      adapter_version: adapterVersion,
      requests: officialSourceDiscoveryRequests(sourceLineage),
    }],
    idempotency_key: `gundam-one-lineage-${crypto.randomUUID()}`,
  });
  expect(oneLocale.response.status).toBe(201);
  expect(oneLocale.document).toMatchObject({
    selected_games: ["gundam"],
    evidence_plans: [{
      supported_game: "gundam",
      source_lineage: sourceLineage,
      adapter_version: adapterVersion,
    }],
  });
  // Admission is the public behavior under test. Release the test database's
  // singleton lock without depending on a live publisher response so the next
  // independent administration scenario can begin.
  await testEnv.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
});

test("a complete Product fixture publishes separated release and distribution records atomically", async () => {
  const run = await collect(
    "/reconciliation/product-release",
    "product-release-complete-fixture",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(
    Array.isArray(reconciled.document.warnings)
      ? reconciled.document.warnings
      : [],
  ).toContainEqual(
    expect.objectContaining({
      code: "product_relationship_unresolved",
      relationship_value: "ST-15 fuzzy label",
    }),
  );
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const [products, releases, contexts, relationships, printings] =
    await Promise.all([
      exportComponentRecords(revisionId, "products"),
      exportComponentRecords(revisionId, "releases"),
      exportComponentRecords(revisionId, "distribution-contexts"),
      exportComponentRecords(revisionId, "relationships"),
      exportComponentRecords(revisionId, "printings"),
    ]);
  const product = products.find(
    (candidate) => candidate.official_code === "ST-15",
  );
  expect(product).toMatchObject({
    official_code: "ST-15",
    name: "Starter Deck RED Edward.Newgate",
    lifecycle: {
      first_revision_id: revisionId,
      last_observed_revision_id: revisionId,
      withdrawn: false,
    },
  });
  if (product === undefined) throw new Error("ST-15 Product missing");
  const productId = requiredString(product, "id");
  const release = releases.find(
    (candidate) =>
      candidate.product_id === productId &&
      candidate.region === "EN-OCEANIA",
  );
  expect(release).toMatchObject({
    product_id: productId,
    region: "EN-OCEANIA",
    date: { precision: "month", value: "2026-09" },
    status: "announced",
  });
  expect((await exportManifest(revisionId)).source_freshness).toEqual(
    expect.arrayContaining([
      {
        game: "one-piece",
        area: "products-and-releases",
        checked_at: expect.any(String),
      },
    ]),
  );
  const context = contexts.find(
    (candidate) =>
      candidate.product_id === productId &&
      candidate.label === "Championship 2026 Participation Pack",
  );
  expect(context).toMatchObject({
    kind: "tournament_pack",
    label: "Championship 2026 Participation Pack",
    product_id: productId,
  });
  if (context === undefined) throw new Error("Distribution Context missing");
  const contextId = requiredString(context, "id");
  const productRelationship = relationships.find(
    (relationship) => {
      const to = relationship.to;
      return (
        to !== null &&
        typeof to === "object" &&
        !Array.isArray(to) &&
        (to as Record<string, unknown>).type === "product" &&
        (to as Record<string, unknown>).id === productId
      );
    },
  );
  expect(productRelationship).toEqual(
    expect.objectContaining({
      from: { type: "printing", id: expect.any(String) },
      to: { type: "product", id: productId },
      evidence_category: "explicit",
    }),
  );
  if (productRelationship === undefined) {
    throw new Error("Printing-to-Product relationship missing");
  }
  const from = productRelationship.from;
  if (from === null || typeof from !== "object" || Array.isArray(from)) {
    throw new Error("Printing relationship source invalid");
  }
  const printingId = requiredString(from as Record<string, unknown>, "id");
  expect(printings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: printingId,
      }),
    ]),
  );
  expect(relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        from: { type: "printing", id: printingId },
        to: { type: "distribution_context", id: contextId },
        evidence_category: "derived",
      }),
    ]),
  );
  expect(
    JSON.stringify({
      product,
      release,
      context,
      relationships: relationships.filter(
        (relationship) => {
          const relationshipFrom = relationship.from;
          return (
            relationshipFrom !== null &&
            typeof relationshipFrom === "object" &&
            !Array.isArray(relationshipFrom) &&
            (relationshipFrom as Record<string, unknown>).type ===
              "printing" &&
            (relationshipFrom as Record<string, unknown>).id === printingId
          );
        },
      ),
    }),
  ).not.toContain("starter-deck-card-list");
  expect(
    relationships.some(
      (relationship) =>
        relationship.relationship_value === "ST-15 fuzzy label",
    ),
  ).toBe(false);
});

test("a Fusion Leader publishes immutable role-labelled Printing Images and export links", async () => {
  const run = await collect(
    "/reconciliation/fusion-leader-images",
    `fusion-leader-images-${crypto.randomUUID()}`,
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const candidate = await reconcile(run.id);
  expect(candidate.response.status).toBe(200);
  const leaderPrintingId = requiredString(
    requiredFirst(candidate.document, "printings"),
    "id",
  );
  const published = await approve(candidate.document);
  expect(
    published.response.status,
    JSON.stringify(published.document),
  ).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const images = (
    await exportComponentRecords(revisionId, "printing-images")
  ).filter(({ printing_id }) => printing_id === leaderPrintingId);
  expect(images).toEqual([
    expect.objectContaining({
      type: "printing_image",
      role: "back",
      content_sha256:
        "eed832d958fc4054fffb3027319dcd914448475c226ce55ae8053a442ed1b2cf",
      content_url: expect.stringMatching(
        /^\/v1\/printing-images\/[^/]+\/content$/u,
      ),
    }),
    expect.objectContaining({
      type: "printing_image",
      role: "front",
      content_sha256:
        "46f3e4bfb8bc9956482a6491e9b968d82e6fd544da44f9f36d93b443b845f773",
      content_url: expect.stringMatching(
        /^\/v1\/printing-images\/[^/]+\/content$/u,
      ),
    }),
  ]);
  for (const image of images) {
    const object = await testEnv.PRINTING_IMAGES.get(
      `printing-images/${image.content_sha256}`,
    );
    expect(object?.size).toBeGreaterThan(0);
    expect(object?.checksums.sha256).toBeDefined();
  }
});

test("distinct official Release events in one region retain stable public identities", async () => {
  const run = await collect(
    "/reconciliation/product-release-multiple-events",
    "product-release-multiple-events",
  );
  const candidate = await reconcile(run.id);
  expect(candidate.response.status).toBe(200);
  const published = await approve(candidate.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const product = (
    await exportComponentRecords(revisionId, "products")
  ).find(({ official_code }) => official_code === "ST-15");
  if (product === undefined) throw new Error("ST-15 Product missing");
  const releases = (
    await exportComponentRecords(revisionId, "releases")
  ).filter(({ product_id }) => product_id === product.id);
  expect(releases).toEqual([
    expect.objectContaining({
      event_key: "oceania-announcement",
      region: "EN-OCEANIA",
      date: { precision: "month", value: "2026-09" },
      status: "announced",
    }),
    expect.objectContaining({
      event_key: "oceania-retail-release",
      region: "EN-OCEANIA",
      date: { precision: "day", value: "2026-09-18" },
      status: "released",
    }),
  ]);
  expect(new Set(releases.map(({ id }) => id)).size).toBe(2);
});

test("a disappeared Distribution Context with no remaining lineage is not current", async () => {
  const firstRun = await collect(
    "/reconciliation/product-release",
    "distribution-context-first-observation",
  );
  const firstCandidate = await reconcile(firstRun.id);
  const firstPublished = await approve(firstCandidate.document);
  expect(firstPublished.response.status).toBe(200);
  const firstRevisionId = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const firstContext = (
    await exportComponentRecords(firstRevisionId, "distribution-contexts")
  ).find(({ label }) => label === "Championship 2026 Participation Pack");
  expect(firstContext?.id).toEqual(expect.any(String));

  const missingRun = await collect(
    "/reconciliation/product-standalone-missing",
    "distribution-context-complete-missing",
  );
  const missingCandidate = await reconcile(missingRun.id);
  const published = await approve(missingCandidate.document);
  expect(published.response.status).toBe(200);
  const stored = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current, source_lineages_json
     FROM reconciled_distribution_contexts
     WHERE context_key = 'championship-2026-pack'`,
  ).first<{ current: number; source_lineages_json: string }>();
  expect(stored).toEqual({
    current: 0,
    source_lineages_json: "[]",
  });
  const missingRevisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  expect(
    await exportComponentRecords(missingRevisionId, "distribution-contexts"),
  ).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: firstContext?.id }),
    ]),
  );
}, 30_000);

test("registered Product detail evidence outranks its conflicting listing through publication", async () => {
  const requests = officialSourceDiscoveryRequests("fusion-world-en").map(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        "user-agent": "card-keepr-product-authority",
      },
    }),
  );
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fusion-world-en@4",
    idempotency_key: "registered-product-detail-authority",
    requests,
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect(
    (
      await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})
    ).response.status,
  ).toBe(202);
  await waitForRunState(runId, "awaiting_approval", 20_000);
  const candidate = await get(`/v1/ingestion-runs/${runId}/candidate`);
  expect(candidate.response.status).toBe(200);
  const published = await approve(candidate.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const productDocument = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_products
     WHERE catalogue_revision_id = ?
       AND json_extract(document_json, '$.data.official_code') = ?`,
  )
    .bind(revisionId, "FB-AUTHORITY")
    .first<{ document_json: string }>();
  expect(JSON.parse(productDocument?.document_json ?? "{}")).toMatchObject({
    data: { name: "Authoritative Product Detail" },
    disagreements: [
      expect.objectContaining({
        path: "/data/name",
        status: "resolved_by_authority",
      }),
    ],
  });
  expect(
    (await exportComponentRecords(revisionId, "products")).find(
      ({ official_code }) => official_code === "FB-AUTHORITY",
    ),
  ).toMatchObject({
    name: "Authoritative Product Detail",
  });
}, 30_000);

test("a registered code-less Product refresh preserves its established code", async () => {
  const start = async (
    state: "coded" | "codeless",
  ) => {
    const requests = officialSourceDiscoveryRequests("fusion-world-en").map(
      (request) => ({
        ...request,
        headers: {
          ...request.headers,
          "user-agent": `card-keepr-product-identity-${state}`,
        },
      }),
    );
    const started = await post("/v1/ingestion-runs/evidence", {
      supported_game: "fusion-world",
      source_lineage: "fusion-world-en",
      adapter_version: "fusion-world-en@4",
      idempotency_key:
        `registered-product-identity-${state}-${crypto.randomUUID()}`,
      requests,
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    expect(
      (
        await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})
      ).response.status,
    ).toBe(202);
    const runDocument = await waitForRunState(
      runId,
      "awaiting_approval",
      20_000,
    );
    return {
      candidate: await get(`/v1/ingestion-runs/${runId}/candidate`),
      runDocument,
    };
  };

  const { candidate: firstCandidate } = await start(
    "coded",
  );
  expect(firstCandidate.response.status).toBe(200);
  const firstPublication = await approve(firstCandidate.document);
  expect(firstPublication.response.status).toBe(200);
  const firstRevision = requiredString(
    firstPublication.document,
    "resulting_revision_id",
  );
  const firstProduct = (
    await exportComponentRecords(firstRevision, "products")
  ).find(({ official_code }) => official_code === "FB-STABLE");
  expect(firstProduct).toMatchObject({
    id: expect.any(String),
    name: "Stable Product Identity",
  });

  const { candidate: refreshCandidate } = await start(
    "codeless",
  );
  expect(refreshCandidate.response.status).toBe(200);
  const refreshPublication = await approve(refreshCandidate.document);
  expect(
    refreshPublication.response.status,
    JSON.stringify(refreshPublication.document),
  ).toBe(200);
  const refreshRevision = requiredString(
    refreshPublication.document,
    "resulting_revision_id",
  );
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      `SELECT json_extract(document_json, '$.data.official_code') AS official_code
       FROM revision_products
       WHERE catalogue_revision_id = ?
         AND product_id = ?`,
    )
      .bind(refreshRevision, firstProduct?.id)
      .first<{ official_code: string | null }>(),
  ).toEqual({ official_code: "FB-STABLE" });
  expect(
    (await exportComponentRecords(refreshRevision, "products")).find(
      ({ id }) => id === firstProduct?.id,
    ),
  ).toMatchObject({
    official_code: "FB-STABLE",
    name: "Stable Product Identity",
  });
}, 45_000);

test("a registered fuzzy Product link remains a review warning through publication", async () => {
  const requests = officialSourceDiscoveryRequests("digimon-en").map(
    (request) => ({
      ...request,
      headers: {
        ...request.headers,
        "user-agent": "card-keepr-product-fuzzy-warning",
      },
    }),
  );
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@3",
    idempotency_key: `registered-product-fuzzy-${crypto.randomUUID()}`,
    requests,
  });
  expect(started.response.status).toBe(201);
  const runId = requiredString(started.document, "id");
  expect(
    (
      await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})
    ).response.status,
  ).toBe(202);
  await waitForRunState(runId, "awaiting_approval", 20_000, 250);
  const candidate = await get(`/v1/ingestion-runs/${runId}/candidate`);
  expect(candidate.response.status).toBe(200);
  expect(
    (candidate.document.diff as { warnings?: unknown[] }).warnings,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "product_relationship_unresolved",
        relationship_value: "Possible Booster Product",
      }),
    ]),
  );
  const publication = await approve(candidate.document);
  expect(
    publication.response.status,
    JSON.stringify(publication.document),
  ).toBe(200);
  const revisionId = requiredString(
    publication.document,
    "resulting_revision_id",
  );
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      `SELECT COUNT(*) AS count
       FROM reconciled_product_relationships
       WHERE relationship_value = ?`,
    )
      .bind("Possible Booster Product")
      .first<{ count: number }>(),
  ).toEqual({ count: 0 });
  expect(
    (await exportComponentRecords(revisionId, "relationships")).some(
      ({ relationship_value }) =>
        relationship_value === "Possible Booster Product",
    ),
  ).toBe(false);
}, 30_000);

test("same-authority Product conflicts fail closed before publication", async () => {
  const run = await collectRequests(
    [
      { id: "product-a", scenario: "product-conflict-a" },
      { id: "product-b", scenario: "product-conflict-b" },
    ],
    "product-conflicting-facts",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(409);
  expect(reconciled.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "Same-authority Product evidence conflicts at /data/name",
        ),
      }),
    ],
  });
});

test("accepted typed Product relationships persist without code/name namespace collisions", async () => {
  const run = await collect(
    "/reconciliation/product-typed-relationships",
    "product-typed-relationships",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const revisionId = requiredString(
    (await approve(reconciled.document)).document,
    "resulting_revision_id",
  );
  const [products, contexts, relationships, cards] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportComponentRecords(revisionId, "relationships"),
    exportComponentRecords(revisionId, "cards"),
  ]);
  const coded = products.find(
    (candidate) => candidate.official_code === "CODE-X",
  );
  const named = products.find(
    (candidate) =>
      candidate.official_code === null && candidate.name === "CODE-X",
  );
  expect(coded?.id).toEqual(expect.any(String));
  expect(named?.id).toEqual(expect.any(String));
  expect(coded?.id).not.toBe(named?.id);
  const context = contexts.find(
    (candidate) => candidate.label === "Typed relationship context",
  );
  expect(context).toMatchObject({ product_id: coded?.id });
  expect(relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "printing-product",
        to: { type: "product", id: coded?.id },
        evidence_category: "explicit",
        source_lineage: "one-piece-en",
        source_observation_ids: [expect.stringMatching(/^srcobs_/)],
      }),
      expect.objectContaining({
        kind: "printing-distribution-context",
        to: { type: "distribution_context", id: context?.id },
        evidence_category: "derived",
      }),
      expect.objectContaining({
        kind: "distribution-context-product",
        from: { type: "distribution_context", id: context?.id },
        to: { type: "product", id: coded?.id },
        evidence_category: "explicit",
      }),
      expect.objectContaining({
        kind: "product-card",
        from: { type: "product", id: named?.id },
        to: { type: "card", id: expect.any(String) },
        evidence_category: "derived",
      }),
    ]),
  );
  const productCard = relationships.find(
    (relationship) =>
      relationship.kind === "product-card" &&
      (relationship.from as Record<string, unknown>).id === named?.id,
  );
  expect(
    cards.some(
      (candidate) =>
        candidate.id ===
        (productCard?.to as Record<string, unknown> | undefined)?.id,
    ),
  ).toBe(true);
  expect(JSON.stringify({ products, contexts, relationships })).not.toContain(
    "typed-source-bucket",
  );
});

test("standalone Product lifecycle survives rename, disappearance, and explicit withdrawal", async () => {
  const firstRun = await collect(
    "/reconciliation/product-standalone-v1",
    "product-standalone-v1",
  );
  const firstCandidate = await reconcile(firstRun.id);
  const firstRevision = requiredString(
    (await approve(firstCandidate.document)).document,
    "resulting_revision_id",
  );

  const secondRun = await collect(
    "/reconciliation/product-standalone-v2",
    "product-standalone-v2",
  );
  const secondCandidate = await reconcile(secondRun.id);
  const secondRevision = requiredString(
    (await approve(secondCandidate.document)).document,
    "resulting_revision_id",
  );
  const secondProduct = (
    await exportComponentRecords(secondRevision, "products")
  ).find((candidate) => candidate.official_code === "ST-STANDALONE");
  expect(secondProduct).toMatchObject({
    name: "Renamed Standalone Product",
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });

  const missingRun = await collect(
    "/reconciliation/product-standalone-missing",
    "product-standalone-missing",
  );
  const missingCandidate = await reconcile(missingRun.id);
  expect(missingCandidate.response.status).toBe(200);
  expect(
    Array.isArray(missingCandidate.document.warnings)
      ? missingCandidate.document.warnings
      : [],
  ).toContainEqual(
    expect.objectContaining({
      code: "product_not_observed",
      product_id: secondProduct?.id,
    }),
  );
  const missingPublication = await approve(missingCandidate.document);
  expect(missingPublication.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: secondRevision,
  });
  const missingRevision = requiredString(
    missingPublication.document,
    "resulting_revision_id",
  );
  const carried = (
    await exportComponentRecords(missingRevision, "products")
  ).find((candidate) => candidate.id === secondProduct?.id);
  expect(carried).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });

  const withdrawnRun = await collect(
    "/reconciliation/product-standalone-withdrawn",
    "product-standalone-withdrawn",
  );
  const withdrawnCandidate = await reconcile(withdrawnRun.id);
  const withdrawnRevision = requiredString(
    (await approve(withdrawnCandidate.document)).document,
    "resulting_revision_id",
  );
  const withdrawn = (
    await exportComponentRecords(withdrawnRevision, "products")
  ).find((candidate) => candidate.id === secondProduct?.id);
  expect(withdrawn).toMatchObject({
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: withdrawnRevision,
      withdrawn: true,
      withdrawal: {
        revision_id: withdrawnRevision,
        evidence: expect.objectContaining({
          assertion: "withdrawn",
          source_observation_id: expect.stringMatching(/^srcobs_/),
        }),
      },
    },
  });
}, 45_000);

test.each([
  {
    label: "inferred membership to typed evidence",
    first: "product-identity-inferred",
    second: "product-identity-typed",
    firstMatch: (product: Record<string, unknown>) =>
      product.official_code === "IDENTITY-INFERRED",
    secondCode: "IDENTITY-INFERRED",
  },
  {
    label: "name-only evidence to official code",
    first: "product-identity-name",
    second: "product-identity-coded",
    firstMatch: (product: Record<string, unknown>) =>
      product.official_code === null &&
      product.name === "Name-to-code Identity Product",
    secondCode: "IDENTITY-NAME-CODE",
  },
  {
    label: "official Product rename",
    first: "product-identity-rename-v1",
    second: "product-identity-rename-v2",
    firstMatch: (product: Record<string, unknown>) =>
      product.official_code === "IDENTITY-RENAME",
    secondCode: "IDENTITY-RENAME",
  },
])(
  "Product identity and lifecycle survive $label",
  async ({ first, second, firstMatch, secondCode }) => {
    const firstRun = await collect(
      `/reconciliation/${first}`,
      `identity-${first}`,
    );
    const firstCandidate = await reconcile(firstRun.id);
    const firstRevision = requiredString(
      (await approve(firstCandidate.document)).document,
      "resulting_revision_id",
    );
    const firstProduct = (
      await exportComponentRecords(firstRevision, "products")
    ).find(firstMatch);
    expect(firstProduct).toBeDefined();
    const firstId = requiredString(firstProduct ?? {}, "id");

    const secondRun = await collect(
      `/reconciliation/${second}`,
      `identity-${second}`,
    );
    const secondCandidate = await reconcile(secondRun.id);
    const secondRevision = requiredString(
      (await approve(secondCandidate.document)).document,
      "resulting_revision_id",
    );
    const secondProduct = (
      await exportComponentRecords(secondRevision, "products")
    ).find(({ official_code }) => official_code === secondCode);
    expect(secondProduct).toMatchObject({
      id: firstId,
      lifecycle: {
        first_revision_id: firstRevision,
        last_observed_revision_id: secondRevision,
        withdrawn: false,
      },
    });
    const persistedIdentity = await env.CATALOGUE_DB.prepare(
      `SELECT id, official_code FROM reconciled_products WHERE id = ?`,
    )
      .bind(firstId)
      .first<{ id: string; official_code: string | null }>();
    expect(persistedIdentity).toEqual({
      id: firstId,
      official_code: secondCode,
    });
    await expect(
      env.CATALOGUE_DB.prepare(
        `UPDATE reconciled_products
         SET official_code = 'INCOMPATIBLE-CODE'
         WHERE id = ?`,
      )
        .bind(firstId)
        .run(),
    ).rejects.toThrow(/reconciled_product_identity_immutable/u);
    const apiProjection = await env.CATALOGUE_DB.prepare(
      `SELECT document_json FROM revision_products
       WHERE catalogue_revision_id = ? AND product_id = ?`,
    )
      .bind(secondRevision, firstId)
      .first<{ document_json: string }>();
    expect(JSON.parse(apiProjection!.document_json)).toMatchObject({
      data: {
        id: firstId,
        official_code: secondCode,
      },
    });
    const productRelationships = await exportComponentRecords(
      secondRevision,
      "relationships",
    );
    expect(
      productRelationships.some((relationship) =>
        [relationship.from, relationship.to].some(
          (endpoint) =>
            typeof endpoint === "object" &&
            endpoint !== null &&
            (endpoint as Record<string, unknown>).id === firstId,
        ),
      ),
    ).toBe(true);
  },
  90_000,
);

test("same-name Products with different official codes remain distinct across revisions", async () => {
  const firstRun = await collect(
    "/reconciliation/product-identity-distinct-code-a",
    "identity-distinct-code-a",
  );
  const firstCandidate = await reconcile(firstRun.id);
  const firstRevision = requiredString(
    (await approve(firstCandidate.document)).document,
    "resulting_revision_id",
  );
  const firstProducts = await exportComponentRecords(
    firstRevision,
    "products",
  );
  const firstProduct = firstProducts.find(
    ({ official_code }) => official_code === "IDENTITY-DISTINCT-A",
  );
  expect(firstProduct).toBeDefined();
  const firstProductId = requiredString(firstProduct ?? {}, "id");
  const firstRelationships = await exportComponentRecords(
    firstRevision,
    "relationships",
  );
  const firstRelationship = firstRelationships.find(
    ({ kind, from }) =>
      kind === "product-card" &&
      typeof from === "object" &&
      from !== null &&
      (from as Record<string, unknown>).id === firstProductId,
  );
  expect(firstRelationship).toBeDefined();
  const firstRelationshipId = requiredString(
    firstRelationship ?? {},
    "id",
  );

  const secondRun = await collect(
    "/reconciliation/product-identity-distinct-code-b",
    "identity-distinct-code-b",
  );
  const secondCandidate = await reconcile(secondRun.id);
  const secondRevision = requiredString(
    (await approve(secondCandidate.document)).document,
    "resulting_revision_id",
  );
  const secondProducts = await exportComponentRecords(
    secondRevision,
    "products",
  );
  const carriedFirst = secondProducts.find(
    ({ official_code }) => official_code === "IDENTITY-DISTINCT-A",
  );
  const distinctSecond = secondProducts.find(
    ({ official_code }) => official_code === "IDENTITY-DISTINCT-B",
  );
  expect(carriedFirst).toMatchObject({
    id: firstProductId,
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: firstRevision,
      withdrawn: false,
    },
  });
  expect(distinctSecond).toMatchObject({
    lifecycle: {
      first_revision_id: secondRevision,
      last_observed_revision_id: secondRevision,
      withdrawn: false,
    },
  });
  const secondProductId = requiredString(distinctSecond ?? {}, "id");
  expect(secondProductId).not.toBe(firstProductId);

  const secondRelationships = await exportComponentRecords(
    secondRevision,
    "relationships",
  );
  expect(
    secondRelationships.find(({ id }) => id === firstRelationshipId),
  ).toMatchObject({
    from: { type: "product", id: firstProductId },
    lifecycle: {
      first_revision_id: firstRevision,
      last_observed_revision_id: firstRevision,
      current: false,
      last_missing_revision_id: secondRevision,
    },
  });
  expect(
    secondRelationships.find(
      ({ kind, from }) =>
        kind === "product-card" &&
        typeof from === "object" &&
        from !== null &&
        (from as Record<string, unknown>).id === secondProductId,
    ),
  ).toMatchObject({
    lifecycle: {
      first_revision_id: secondRevision,
      last_observed_revision_id: secondRevision,
      current: true,
      last_missing_revision_id: null,
    },
  });
}, 90_000);

test("a name-only Product matching multiple published Products fails closed without publication", async () => {
  for (const scenario of [
    "product-identity-distinct-code-a",
    "product-identity-distinct-code-b",
  ]) {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `identity-ambiguous-prior-${scenario}`,
    );
    const candidate = await reconcile(run.id);
    expect(candidate.response.status).toBe(200);
    expect((await approve(candidate.document)).response.status).toBe(200);
  }
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<{ current_revision_id: string }>();

  const ambiguous = await collect(
    "/reconciliation/product-identity-ambiguous-name",
    "identity-ambiguous-name-only",
  );
  await expectRetainedEvidenceInvalid(
    ambiguous.id,
    "matched multiple published Products",
  );
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
    ).first<{ current_revision_id: string }>(),
  ).toEqual(currentBefore);
}, 90_000);

test("conflicting Distribution Context facts fail closed without publication", async () => {
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<{ current_revision_id: string }>();
  const run = await collectRequests(
    [
      { id: "context-a", scenario: "product-context-conflict-a" },
      { id: "context-b", scenario: "product-context-conflict-b" },
    ],
    "product-context-conflicting-facts",
  );

  await expectRetainedEvidenceInvalid(
    run.id,
    "Distribution Context facts conflict",
  );
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
    ).first<{ current_revision_id: string }>(),
  ).toEqual(currentBefore);
});

test("identical Product facts are a semantic no-change while source freshness advances", async () => {
  const firstRun = await collect(
    "/reconciliation/product-standalone-v1",
    "product-semantic-first",
  );
  const firstCandidate = await reconcile(firstRun.id);
  const firstPublished = await approve(firstCandidate.document);
  const revisionId = requiredString(
    firstPublished.document,
    "resulting_revision_id",
  );
  const firstFreshness = await testEnv.CATALOGUE_DB.prepare(
    `SELECT checked_at
     FROM source_freshness
     WHERE game = 'one-piece'
       AND area = 'products-and-releases'`,
  ).first<{ checked_at: string }>();

  const secondRun = await collect(
    "/reconciliation/product-standalone-v1",
    "product-semantic-second",
  );
  const secondCandidate = await reconcile(secondRun.id);
  expect(secondCandidate.document.candidate_digest).not.toBe(
    firstCandidate.document.candidate_digest,
  );
  const secondPublished = await approve(secondCandidate.document);
  expect(secondPublished.document).toMatchObject({
    publication_outcome: "no_change",
    resulting_revision_id: revisionId,
  });
  const secondFreshness = await testEnv.CATALOGUE_DB.prepare(
    `SELECT checked_at
     FROM source_freshness
     WHERE game = 'one-piece'
       AND area = 'products-and-releases'`,
  ).first<{ checked_at: string }>();
  expect(secondFreshness?.checked_at).not.toBe(firstFreshness?.checked_at);
}, 45_000);

test("Product observations and disappearance remain scoped to their Source Lineage", async () => {
  const asiaSource = {
    game: "gundam",
    lineage: "gundam-en-asia",
    adapter: "fixture-gundam-en-asia-json@1",
  };
  const usSource = {
    game: "gundam",
    lineage: "gundam-en-us",
    adapter: "fixture-gundam-en-us-json@1",
  };
  const asiaRun = await collect(
    "/reconciliation/gundam-product-asia",
    "gundam-product-asia",
    asiaSource,
  );
  const asiaCandidate = await reconcile(asiaRun.id);
  const asiaApproval = await approve(asiaCandidate.document);
  if (asiaApproval.response.status !== 200) {
    throw new Error(JSON.stringify(asiaApproval.document));
  }
  const asiaRevision = requiredString(
    asiaApproval.document,
    "resulting_revision_id",
  );

  const usRun = await collect(
    "/reconciliation/gundam-product-us",
    "gundam-product-us",
    usSource,
  );
  const usCandidate = await reconcile(usRun.id);
  const combined = requiredFirst(usCandidate.document, "products");
  expect(combined.releases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
  expect(
    new Set(
      (combined.releases as Record<string, unknown>[]).map(({ id }) => id),
    ).size,
  ).toBe(2);
  expect(combined.included).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: "gundam-en-asia" }),
      expect.objectContaining({ source: "gundam-en-us" }),
    ]),
  );
  expect(
    new Set(
      Object.values(
        combined.provenance as Record<string, string[]>,
      ).flat(),
    ).size,
  ).toBeGreaterThanOrEqual(2);
  const usRevision = requiredString(
    (await approve(usCandidate.document)).document,
    "resulting_revision_id",
  );

  const asiaMissingRun = await collect(
    "/reconciliation/gundam-product-asia-missing",
    "gundam-product-asia-missing",
    asiaSource,
  );
  const asiaMissing = await reconcile(asiaMissingRun.id);
  const missingRevision = requiredString(
    (await approve(asiaMissing.document)).document,
    "resulting_revision_id",
  );
  const storedProduct = await testEnv.CATALOGUE_DB.prepare(
    `SELECT document_json
     FROM revision_products
     WHERE catalogue_revision_id = ?
       AND official_code = 'GD-CROSS'`,
  )
    .bind(missingRevision)
    .first<{ document_json: string }>();
  const carried = JSON.parse(
    storedProduct?.document_json ?? "{}",
  ) as Record<string, unknown>;
  expect(carried).toMatchObject({
    data: {
      releases: [expect.objectContaining({ region: "EN-US" })],
    },
    included: [
      expect.objectContaining({ source: "gundam-en-us" }),
    ],
  });
  expect(
    JSON.stringify(carried).includes("gundam-en-asia"),
  ).toBe(false);
  const exported = (
    await exportComponentRecords(missingRevision, "products")
  ).find((product) => product.official_code === "GD-CROSS");
  expect(exported).toMatchObject({
    lifecycle: {
      first_revision_id: asiaRevision,
      last_observed_revision_id: usRevision,
      withdrawn: false,
    },
  });
  const releases = await testEnv.CATALOGUE_DB.prepare(
    `SELECT region, first_revision_id, last_observed_revision_id
     FROM reconciled_releases
     WHERE product_id = ?
     ORDER BY region`,
  )
    .bind(requiredString(exported ?? {}, "id"))
    .all<{
      region: string;
      first_revision_id: string;
      last_observed_revision_id: string;
    }>();
  expect(releases.results).toEqual([
    {
      region: "EN-ASIA",
      first_revision_id: asiaRevision,
      last_observed_revision_id: asiaRevision,
    },
    {
      region: "EN-US",
      first_revision_id: usRevision,
      last_observed_revision_id: usRevision,
    },
  ]);
}, 45_000);

test("only an actual Product surface checks its Gundam Source Lineage", async () => {
  const usRun = await collect(
    "/reconciliation/gundam-product-us",
    "gundam-product-us-prior-to-mixed-run",
    {
      game: "gundam",
      lineage: "gundam-en-us",
      adapter: "fixture-gundam-en-us-json@1",
    },
  );
  const usCandidate = await reconcile(usRun.id);
  expect(usCandidate.response.status).toBe(200);
  expect((await approve(usCandidate.document)).response.status).toBe(200);

  const mixed = await postFixtureEvidence({
    idempotency_key: "gundam-mixed-product-and-card-surfaces",
    plans: [
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-asia",
        adapter_version: "fixture-gundam-en-asia-json@1",
        requests: [
          {
            id: "asia-product",
            method: "GET",
            url:
              "https://official-source.invalid/reconciliation/" +
              "gundam-product-asia",
            headers: { accept: "application/json" },
          },
        ],
      },
      {
        supported_game: "gundam",
        source_lineage: "gundam-en-us",
        adapter_version: "fixture-gundam-en-us-json@1",
        requests: [
          {
            id: "us-card",
            method: "GET",
            url:
              "https://official-source.invalid/reconciliation/" +
              "gundam-cross-us",
            headers: { accept: "application/json" },
          },
        ],
      },
    ],
  });
  expect(mixed.response.status).toBe(201);
  const runId = requiredString(mixed.document, "id");
  expect(
    (
      await post(`/v1/ingestion-runs/${runId}/collection/resume`, {})
    ).response.status,
  ).toBe(202);
  await waitForRunState(runId, "parsing");
  const candidate = await reconcile(runId);
  expect(candidate.response.status).toBe(200);
  const product = (candidate.document.products as Record<string, unknown>[])
    .find(({ official_code }) => official_code === "GD-CROSS");
  expect(product?.releases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
  expect(candidate.document.warnings ?? []).not.toContainEqual(
    expect.objectContaining({
      code: "product_not_observed",
      source_lineages: expect.arrayContaining(["gundam-en-us"]),
    }),
  );

  const published = await approve(candidate.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const exportedProduct = (
    await exportComponentRecords(revisionId, "products")
  ).find(({ official_code }) => official_code === "GD-CROSS");
  expect(exportedProduct).toBeDefined();
  const exportedReleases = (
    await exportComponentRecords(revisionId, "releases")
  ).filter(({ product_id }) => product_id === exportedProduct?.id);
  expect(exportedReleases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ region: "EN-ASIA" }),
      expect.objectContaining({ region: "EN-US" }),
    ]),
  );
}, 90_000);

test("Product freshness is emitted only for an actually checked Product surface", async () => {
  const checkedRun = await collect(
    "/reconciliation/product-standalone-v1",
    "product-freshness-checked",
  );
  const checkedCandidate = await reconcile(checkedRun.id);
  const checkedPublication = await approve(checkedCandidate.document);
  expect(
    checkedPublication.response.status,
    JSON.stringify(checkedPublication.document),
  ).toBe(200);
  const checkedRevision = requiredString(
    checkedPublication.document,
    "resulting_revision_id",
  );
  const checkedSnapshot = await testEnv.CATALOGUE_DB.prepare(
    `SELECT retrieved_at
     FROM source_snapshots
     WHERE ingestion_run_id = ?`,
  )
    .bind(checkedRun.id)
    .first<{ retrieved_at: string }>();
  expect(
    await testEnv.CATALOGUE_DB.prepare(
      `SELECT checked_at
       FROM source_freshness
       WHERE game = 'one-piece'
         AND area = 'products-and-releases'`,
    ).first<{ checked_at: string }>(),
  ).toEqual({ checked_at: checkedSnapshot?.retrieved_at });

  const noCheckRun = await collect(
    "/reconciliation/base",
    "product-freshness-no-check",
  );
  const noCheckCandidate = await reconcile(noCheckRun.id);
  const noCheckRevision = requiredString(
    (await approve(noCheckCandidate.document)).document,
    "resulting_revision_id",
  );
  const carriedFreshness = (
    await exportManifest(noCheckRevision)
  ).source_freshness.find(
    ({ game, area }) =>
      game === "one-piece" && area === "products-and-releases",
  );
  expect(carriedFreshness).toEqual(
    (await exportManifest(checkedRevision)).source_freshness.find(
      ({ game, area }) =>
        game === "one-piece" && area === "products-and-releases",
    ),
  );
  expect(
    await exportComponentRecords(noCheckRevision, "products"),
  ).toContainEqual(
    expect.objectContaining({
      official_code: "ST-STANDALONE",
      lifecycle: expect.objectContaining({
        last_observed_revision_id: checkedRevision,
      }),
    }),
  );
}, 30_000);

test("a Digimon Release with unknown region remains schema-valid in the export", async () => {
  const run = await collect(
    "/reconciliation/digimon-product-unknown-region",
    "digimon-product-unknown-region",
    {
      game: "digimon",
      lineage: "digimon-en",
      adapter: "fixture-digimon-json@1",
    },
  );
  const candidate = await reconcile(run.id);
  expect(candidate.response.status).toBe(200);
  const revisionId = requiredString(
    (await approve(candidate.document)).document,
    "resulting_revision_id",
  );
  expect(
    await exportComponentRecords(revisionId, "releases"),
  ).toContainEqual(
    expect.objectContaining({
      region: "unknown",
      date: { precision: "unknown", value: null },
    }),
  );
});

test("unknown Product relationship resolution fails closed", async () => {
  const run = await collect(
    "/reconciliation/product-invalid-resolution",
    "product-invalid-resolution",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(409);
  expect(reconciled.document).toMatchObject({
    state: "failed",
    publishable: false,
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(
          "Product relationship resolution is invalid",
        ),
      }),
    ],
  });
});

test("Product-only Official Source surfaces reconcile without fabricating a Card", async () => {
  const run = await collect(
    "/reconciliation/product-only-surface",
    "product-only-surface",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  expect(reconciled.document).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
    cards: [],
    printings: [],
    products: [
      expect.objectContaining({
        official_code: "ST-PRODUCT-ONLY",
        releases: [
          expect.objectContaining({
            status: "announced",
            date: { precision: "quarter", value: "2027-Q1" },
          }),
        ],
      }),
    ],
  });
  const revisionId = requiredString(
    (await approve(reconciled.document)).document,
    "resulting_revision_id",
  );
  const exportedRelationships = await exportComponentRecords(
    revisionId,
    "relationships",
  );
  expect(exportedRelationships).toContainEqual(
    expect.objectContaining({
      kind: "distribution-context-product",
      from: expect.objectContaining({ type: "distribution_context" }),
      to: expect.objectContaining({ type: "product" }),
      evidence_category: "explicit",
      relationship_value: "ST-PRODUCT-ONLY",
    }),
  );
});

test.each([
  ["product-explicit-derived", "explicit", "derived"],
  ["product-deterministic-explicit", "deterministic", "explicit"],
])(
  "relationship resolution %s rejects contradictory evidence coupling",
  async (scenario, resolution, category) => {
    const run = await collect(
      `/reconciliation/${scenario}`,
      `coupling-${scenario}`,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(409);
    expect(reconciled.document).toMatchObject({
      state: "failed",
      publishable: false,
      diagnostics: [
        expect.objectContaining({
          code: "retained_evidence_invalid",
          detail: expect.stringContaining(
            `${resolution} resolution requires ${category === "derived" ? "explicit" : "derived"} evidence`,
          ),
        }),
      ],
    });
  },
);

test("streamed catalogue gzip is byte-identical to the checked-in golden bytes", async () => {
  const built = await buildCatalogueExport(
    {
      contract: catalogueCandidateContract,
      selected_games: ["one-piece"],
      cards: [],
      printings: [],
      products: [],
      distribution_contexts: [],
      product_relationships: [],
      product_observed_games: [],
      product_observed_lineages: [],
    },
    "a".repeat(64),
    "catrev_gzip_golden",
    "2026-07-30T01:02:03.000Z",
  );
  const object = built.objects.find(({ contentEncoding }) =>
    contentEncoding === "gzip"
  );
  if (object === undefined) throw new Error("gzip component missing");
  const { readable, completed } = object.body();
  const bytes = new Uint8Array(await new Response(readable).arrayBuffer());
  await completed;
  expect(Buffer.from(bytes).toString("hex")).toBe(
    EMPTY_CATALOGUE_GZIP_HEX,
  );
  expect([...bytes.slice(0, 10)]).toEqual([
    0x1f, 0x8b, 0x08, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x02, 0xff,
  ]);
  expect((bytes[10]! >> 1) & 0b11).toBe(0b01);
  expect(await sha256(bytes)).toBe(object.sha256);
});

test("every v2 export component orders opaque IDs by normalized UTF-8 bytes", async () => {
  const product = (id: string, releaseId: string) => ({
    reference: { kind: "official_code" as const, value: id },
    id,
    game: "one-piece" as const,
    official_code: id,
    name: id,
    releases: [{
      id: releaseId,
      event_key: releaseId,
      product_id: id,
      region: "unknown" as const,
      date: { precision: "unknown" as const, value: null },
      status: "announced" as const,
    }],
    observed: true,
    withdrawal: null,
    included: [],
    provenance: {},
    disagreements: [],
    source_observations: [],
  });
  const built = await buildCatalogueExport(
    {
      contract: catalogueCandidateContract,
      selected_games: ["one-piece"],
      cards: [],
      printings: [],
      products: [
        product("product_Z", "release_Z"),
        product("product:A", "release:A"),
        product("product.a", "release.a"),
      ],
      distribution_contexts: [],
      product_relationships: [],
      product_observed_games: ["one-piece"],
      product_observed_lineages: ["one-piece-en"],
    },
    "f".repeat(64),
    "catrev_utf8_component_order",
    "2026-07-30T01:02:03.000Z",
  );
  const records = async (name: string) => {
    const index = built.manifest.components.findIndex(
      (component) => component.name === name,
    );
    const object = built.objects[index];
    if (object === undefined) throw new Error(`${name} component missing`);
    const { readable, completed } = object.body();
    const text = await new Response(
      readable.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    await completed;
    return text.trim().split("\n").filter(Boolean).map(
      (line) => JSON.parse(line) as { id: string },
    );
  };

  expect((await records("products")).map(({ id }) => id)).toEqual([
    "product.a",
    "product:A",
    "product_Z",
  ]);
  expect((await records("releases")).map(({ id }) => id)).toEqual([
    "release.a",
    "release:A",
    "release_Z",
  ]);
});

test("deterministic gzip profile matches independent full-byte edge-case goldens", async () => {
  const candidateProduct = (
    id: string,
    officialCode: string | null,
    name: string | null,
  ) => ({
    reference: {
      kind: officialCode === null ? "name" as const : "official_code" as const,
      value: officialCode ?? name ?? id,
    },
    id,
    game: "one-piece" as const,
    official_code: officialCode,
    name,
    releases: [],
    observed: true,
    withdrawal: null,
    included: [],
    provenance: {},
    disagreements: [],
    source_observations: [],
  });
  const base = {
    contract: catalogueCandidateContract,
    selected_games: ["one-piece" as const],
    cards: [],
    printings: [],
    products: [],
    distribution_contexts: [],
    product_relationships: [],
    product_observed_games: [],
    product_observed_lineages: [],
  };
  const cases = [
    {
      name: "non_ascii_nfc" as const,
      component: 5,
      candidate: {
        ...base,
        products: [
          candidateProduct("product_nfc", "NFC-1", "Café Étude"),
        ],
      },
    },
    {
      name: "null_values" as const,
      component: 5,
      candidate: {
        ...base,
        products: [candidateProduct("product_null", null, null)],
      },
    },
    {
      name: "empty_component" as const,
      component: 3,
      candidate: base,
    },
    {
      name: "multiple_deflate_blocks" as const,
      component: 5,
      candidate: {
        ...base,
        // 80,257 canonical UTF-8 bytes cross the fixed-Huffman reference
        // encoder's DEFLATE block boundary.
        products: [
          candidateProduct(
            "product_blocks",
            "BLOCKS",
            `Block ${"abcdef0123456789".repeat(5_000)}`,
          ),
        ],
      },
    },
  ];
  for (const fixture of cases) {
    const built = await buildCatalogueExport(
      fixture.candidate,
      "b".repeat(64),
      `catrev_gzip_${fixture.name}`,
      "2026-07-30T01:02:03.000Z",
    );
    const object = built.objects[fixture.component];
    if (object === undefined) throw new Error("gzip component missing");
    const { readable, completed } = object.body();
    const hex = Buffer.from(
      await new Response(readable).arrayBuffer(),
    ).toString("hex");
    await completed;
    expect(hex).toBe(GZIP_PROFILE_GOLDENS[fixture.name]);
  }
}, 45_000);

test("heterogeneous empty plans report each lineage independently regardless of plan order", async () => {
  const seededRun = await collect(
    "/reconciliation/profile-fusion-world",
    "mixed-plan-empty-lineage-seed",
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@1",
    },
  );
  const seeded = await reconcile(seededRun.id);
  const cardId = requiredString(requiredFirst(seeded.document, "cards"), "id");
  const printingId = requiredString(
    requiredFirst(seeded.document, "printings"),
    "id",
  );
  expect((await approve(seeded.document)).response.status).toBe(200);

  const inspectOrder = async (
    lineages: readonly ("one-piece" | "fusion-world")[],
    suffix: string,
  ) => {
    const started = await postFixtureEvidence({
      idempotency_key: `mixed-plan-empty-lineage-${suffix}`,
      plans: lineages.map((game) => ({
        supported_game: game,
        source_lineage: game === "one-piece"
          ? "one-piece-en"
          : "fusion-world-en",
        adapter_version: game === "one-piece"
          ? "fixture-one-piece-json@1"
          : "fixture-fusion-world-json@1",
        requests: [{
          id: `${game}-empty-${suffix}`,
          method: "GET" as const,
          url:
            "https://official-source.invalid/reconciliation/complete-empty-lineage",
          headers: { accept: "application/json" },
        }],
      })),
    });
    expect(started.response.status).toBe(201);
    const runId = requiredString(started.document, "id");
    expect((await post(
      `/v1/ingestion-runs/${runId}/collection/resume`,
      {},
    )).response.status).toBe(202);
    await waitForRunState(runId, "parsing");
    const candidate = await reconcile(runId);
    expect(candidate.response.status).toBe(200);
    const inspected = await get(`/v1/ingestion-runs/${runId}/candidate`);
    const result = {
      cards: (inspected.document.diff as {
        cards: { missing_observations: string[] };
      }).cards.missing_observations,
      printings: (inspected.document.diff as {
        printings: { missing_observations: string[] };
      }).printings.missing_observations,
    };
    expect((await post(`/v1/ingestion-runs/${runId}/rejection`, {
      candidate_digest: requiredString(candidate.document, "candidate_digest"),
      idempotency_key: `reject-mixed-plan-empty-lineage-${suffix}`,
    })).response.status).toBe(200);
    return result;
  };

  const forward = await inspectOrder(
    ["one-piece", "fusion-world"],
    "forward",
  );
  const reversed = await inspectOrder(
    ["fusion-world", "one-piece"],
    "reversed",
  );
  expect(forward).toEqual(reversed);
  expect(forward.cards).toContain(cardId);
  expect(forward.printings).toContain(printingId);
}, 45_000);

test("a Product-heavy export publishes bounded verified R2 components", async () => {
  const run = await collect(
    "/reconciliation/scale-1001-products",
    "bounded-export-scale-1001-products",
    undefined,
    45_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const [products, releases, contexts, manifest] = await Promise.all([
    exportComponentRecords(revisionId, "products"),
    exportComponentRecords(revisionId, "releases"),
    exportComponentRecords(revisionId, "distribution-contexts"),
    exportManifest(revisionId),
  ]);
  const scaleProducts = products.filter(({ official_code }) =>
    /^SC-[0-9]{4}$/u.test(String(official_code)),
  );
  expect(scaleProducts).toHaveLength(1_001);
  const scaleProductIds = new Set(
    scaleProducts.map(({ id }) => String(id)),
  );
  expect(
    releases.filter(({ product_id }) =>
      scaleProductIds.has(String(product_id)),
    ),
  ).toHaveLength(1_001);
  expect(
    contexts.filter(({ product_id }) =>
      scaleProductIds.has(String(product_id)),
    ),
  ).toHaveLength(1_001);
  const productBytes = manifest.components
    .filter(({ name }) =>
      ["products", "releases", "distribution-contexts"].includes(name),
    )
    .reduce((total, component) => total + component.uncompressed_bytes, 0);
  expect(productBytes).toBeGreaterThan(8 * 1024 * 1024);
  for (const component of manifest.components) {
    const key =
      `catalogue-exports/${revisionId}/components/` +
      `${component.compressed_sha256}.ndjson.gz`;
    const stored = await testEnv.CATALOGUE_EXPORTS.head(key);
    expect(stored?.size).toBe(component.compressed_bytes);
    expect(stored?.checksums.sha256).toBeDefined();
  }
}, 120_000);

test("Card search repair permits only retained revisions and revalidates unfinished replay claims", async () => {
  const publishScenario = async (sequence: number) => {
    const run = await collect(
      `/reconciliation/search-repair-retention-${sequence}`,
      `repair-retention-${sequence}`,
    );
    const reconciled = await reconcile(run.id);
    expect(reconciled.response.status).toBe(200);
    const published = await approve(reconciled.document);
    expect(published.response.status).toBe(200);
    return requiredString(published.document, "resulting_revision_id");
  };
  const revisionLineage = () =>
    testEnv.CATALOGUE_DB.prepare(
      `WITH RECURSIVE lineage(revision_id, depth) AS (
         SELECT current_revision_id, 0
         FROM catalogue_state
         WHERE singleton = 1
         UNION ALL
         SELECT revision.expected_previous_revision_id,
                lineage.depth + 1
         FROM lineage
         JOIN catalogue_revisions AS revision
           ON revision.id = lineage.revision_id
         WHERE lineage.depth < 4
       )
       SELECT revision_id, depth
       FROM lineage
       ORDER BY depth`,
    ).all<{ revision_id: string; depth: number }>();
  let lineage = (await revisionLineage()).results;
  for (let sequence = 1; lineage.length < 5; sequence += 1) {
    await publishScenario(sequence);
    lineage = (await revisionLineage()).results;
  }
  const currentRevisionId = lineage[0]!.revision_id;
  const retained = await post(
    "/v1/catalogue-search-materialization/repair",
    {
      target_revision_id: lineage[2]!.revision_id,
      expected_current_revision_id: currentRevisionId,
      idempotency_key: "repair-retained-second-predecessor",
    },
  );
  expect(retained.response.status).toBe(200);

  const archived = await post(
    "/v1/catalogue-search-materialization/repair",
    {
      target_revision_id: lineage[3]!.revision_id,
      expected_current_revision_id: currentRevisionId,
      idempotency_key: "reject-archived-repair-target",
    },
  );
  expect(archived.response.status).toBe(409);
  expect(archived.document).toMatchObject({
    code: "catalogue_revision_not_repairable",
  });

  const unfinishedRequest = {
    target_revision_id: currentRevisionId,
    expected_current_revision_id: currentRevisionId,
    idempotency_key: "stale-unfinished-repair-replay",
  };
  await testEnv.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_search_repair_requests (
       idempotency_key, target_revision_id,
       expected_current_revision_id, request_json, result_json
     ) VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      unfinishedRequest.idempotency_key,
      unfinishedRequest.target_revision_id,
      unfinishedRequest.expected_current_revision_id,
      canonicalJson(unfinishedRequest),
      canonicalJson({
        contract: "card-keepr-card-search-repair@1",
        complete: false,
        processed_cards: 25,
        revisions_available: 1,
        maximum_bound_parameter_bytes: 65_536,
      }),
    )
    .run();
  await publishScenario(5);

  const staleReplay = await post(
    "/v1/catalogue-search-materialization/repair",
    unfinishedRequest,
  );
  expect(staleReplay.response.status).toBe(409);
  expect(staleReplay.document).toMatchObject({
    code: "current_revision_mismatch",
  });
}, 60_000);

test("Card search repair binds exact target/current/idempotency and fails stale or conflicting requests closed", async () => {
  const run = await collect(
    "/reconciliation/complete-empty-lineage",
    "guarded-search-repair-published-target",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const request = {
    target_revision_id: revisionId,
    expected_current_revision_id: revisionId,
    idempotency_key: "guarded-search-repair",
  };
  const first = await post(
    "/v1/catalogue-search-materialization/repair",
    request,
  );
  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-search-repair@1",
    complete: expect.any(Boolean),
  });
  const replay = await post(
    "/v1/catalogue-search-materialization/repair",
    request,
  );
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(first.document);

  const conflict = await post(
    "/v1/catalogue-search-materialization/repair",
    {
      ...request,
      target_revision_id: "catrev_conflicting_repair_target",
    },
  );
  expect(conflict.response.status).toBe(409);
  expect(conflict.document).toMatchObject({ code: "idempotency_conflict" });

  const stale = await post(
    "/v1/catalogue-search-materialization/repair",
    {
      target_revision_id: revisionId,
      expected_current_revision_id: "catrev_stale_repair_current",
      idempotency_key: "guarded-search-repair-stale",
    },
  );
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({ code: "current_revision_mismatch" });
}, 60_000);

test("one Card search repair idempotency key resumes bounded steps and replays only its completed result", async () => {
  const run = await collect(
    "/reconciliation/complete-empty-lineage",
    "bounded-25-card-search-repair",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const cards = Array.from({ length: 30 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const id = `card_bounded_search_repair_${ordinal}`;
    return {
      id,
      document: JSON.stringify({
        type: "card",
        id,
        game: "one-piece",
        official_identity: {
          kind: "card_number",
          value: `BOUND-${ordinal}`,
        },
        name: `Bounded repair Card ${ordinal}`,
        effective_rules_text: `Draw ${index + 1} cards.`,
        game_data: {},
        lifecycle: {},
        links: {},
      }),
    };
  });
  await testEnv.CATALOGUE_DB.batch([
    ...cards.map(({ id, document }) =>
      testEnv.CATALOGUE_DB.prepare(
        `INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         ) VALUES (?, ?, ?)`,
      ).bind(revisionId, id, document)
    ),
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM catalogue_query_revisions
       WHERE catalogue_revision_id = ?`,
    ).bind(revisionId),
  ]);

  const repair = () =>
    post("/v1/catalogue-search-materialization/repair", {
      target_revision_id: revisionId,
      expected_current_revision_id: revisionId,
      idempotency_key: "bounded-25-card-search-repair",
    });
  const first = await repair();
  expect(first.response.status).toBe(200);
  expect(first.document).toMatchObject({
    contract: "card-keepr-card-search-repair@1",
    complete: false,
    processed_cards: 25,
  });
  expect(
    Number(first.document.maximum_bound_parameter_bytes),
  ).toBeLessThanOrEqual(65_536);

  const revisionCardCount = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM revision_cards
     WHERE catalogue_revision_id = ?`,
  ).bind(revisionId).first<{ count: number }>();
  const maximumRepairCalls =
    Math.ceil(Number(revisionCardCount?.count ?? 0) / 25) + 1;
  let current = first;
  for (
    let call = 2;
    current.document.complete !== true && call <= maximumRepairCalls;
    call += 1
  ) {
    current = await repair();
    expect(current.response.status).toBe(200);
    expect(current.document).toMatchObject({
      contract: "card-keepr-card-search-repair@1",
    });
    expect(Number(current.document.processed_cards)).toBeLessThanOrEqual(25);
    expect(
      Number(current.document.maximum_bound_parameter_bytes),
    ).toBeLessThanOrEqual(65_536);
  }
  expect(current.document.complete).toBe(true);
  const replay = await repair();
  expect(replay.response.status).toBe(200);
  expect(replay.document).toEqual(current.document);
}, 60_000);

test("Card search repair rejects an oversized legacy Card before materializing it", async () => {
  const run = await collect(
    "/reconciliation/base",
    "oversized-legacy-search-repair",
  );
  const reconciled = await reconcile(run.id);
  expect(reconciled.response.status).toBe(200);
  const published = await approve(reconciled.document);
  expect(published.response.status).toBe(200);
  const revisionId = requiredString(
    published.document,
    "resulting_revision_id",
  );
  const oversizedCardId = "card_oversized_legacy_search_repair";
  await testEnv.CATALOGUE_DB.batch([
    testEnv.CATALOGUE_DB.prepare(
      `INSERT INTO revision_cards (
         catalogue_revision_id, card_id, document_json
       ) VALUES (?, ?, ?)`,
    ).bind(
      revisionId,
      oversizedCardId,
      JSON.stringify({
        type: "card",
        id: oversizedCardId,
        game: "one-piece",
        official_identity: {
          kind: "card_number",
          value: "OVERSIZED-001",
        },
        name: "Oversized legacy Card",
        effective_rules_text: "x".repeat(65_536),
        game_data: {},
        lifecycle: {},
        links: {},
      }),
    ),
    testEnv.CATALOGUE_DB.prepare(
      `DELETE FROM catalogue_query_revisions
       WHERE catalogue_revision_id = ?`,
    ).bind(revisionId),
  ]);

  const repair = await post(
    "/v1/catalogue-search-materialization/repair",
    {
      target_revision_id: revisionId,
      expected_current_revision_id: revisionId,
      idempotency_key: "reject-oversized-legacy-search-repair",
    },
  );
  expect(repair.response.status).toBe(422);
  expect(repair.document).toMatchObject({
    code: "catalogue_search_repair_source_too_large",
    detail:
      "A retained Card exceeds the durable 65536-byte search repair source bound.",
  });
}, 60_000);

test("publication rejects an over-budget candidate before writing any immutable object", async () => {
  const run = await collect(
    "/reconciliation/export-component-over-budget",
    "reconcile-export-component-over-budget",
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first<{ current_revision_id: string }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list())
    .objects.map((object) => object.key).sort();

  const blocked = await approve(reconciled.document);
  const objectsAfter = (await testEnv.CATALOGUE_EXPORTS.list())
    .objects.map((object) => object.key).sort();
  const currentAfter = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first<{ current_revision_id: string }>();

  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "publication_aggregate_too_large",
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({
    state: "failed",
    failure_code: "publication_aggregate_too_large",
  });
  expect(objectsAfter).toEqual(objectsBefore);
  expect(currentAfter).toEqual(currentBefore);
});

test("an oversized legality relationship export fails terminally before reservation and replays the problem", async () => {
  const run = await collect(
    "/reconciliation/legality-relationship-over-budget",
    "reconcile-legality-relationship-over-budget",
    {
      game: "one-piece",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
    },
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  expect(reconciled.document).toMatchObject({
    state: "awaiting_approval",
    publishable: true,
  });
  const approvalKey = "approve-legality-relationship-over-budget";
  const approvalRequest = {
    candidate_digest: requiredString(
      reconciled.document,
      "candidate_digest",
    ),
    expected_current_revision_id: requiredString(
      reconciled.document,
      "expected_current_revision_id",
    ),
    idempotency_key: approvalKey,
  };
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first<{ current_revision_id: string }>();
  const revisionsBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first<{ count: number }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list())
    .objects.map((object) => object.key).sort();

  const blocked = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    approvalRequest,
  );
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "catalogue_export_too_large",
  });

  const storedFailure = await testEnv.CATALOGUE_DB.prepare(
    `SELECT state, failure_code FROM ingestion_runs WHERE id = ?`,
  )
    .bind(run.id)
    .first<{ state: string; failure_code: string | null }>();
  expect(storedFailure).toEqual({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const shown = await get(`/v1/ingestion-runs/${run.id}`);
  expect(shown.response.status).toBe(200);
  expect(shown.document).toMatchObject({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const lifecycle = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT COUNT(*) FROM administration_idempotency
        WHERE idempotency_key = ?
          AND operation = 'approve_ingestion_run'
          AND outcome = 'problem') AS outcomes,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id`,
  )
    .bind(approvalKey, approvalKey)
    .first<{
      claims: number;
      outcomes: number;
      active_ingestion_run_id: string | null;
    }>();
  expect(lifecycle).toEqual({
    claims: 0,
    outcomes: 1,
    active_ingestion_run_id: null,
  });

  const replay = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    approvalRequest,
  );
  expect(replay.response.status).toBe(blocked.response.status);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
  });
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first()).toEqual(currentBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first()).toEqual(revisionsBefore);
});

test("reserved oversized legality relationship recovery preserves the typed terminal problem", async () => {
  const run = await collect(
    "/reconciliation/legality-relationship-over-budget",
    "reconcile-reserved-legality-relationship-over-budget",
    {
      game: "one-piece",
      lineage: "one-piece-en",
      adapter: "fixture-one-piece-json@3",
    },
    30_000,
  );
  const reconciled = await reconcile(run.id);
  if (reconciled.response.status !== 200) {
    throw new Error(JSON.stringify(reconciled.document));
  }
  const digest = requiredString(reconciled.document, "candidate_digest");
  const expectedRevision = requiredString(
    reconciled.document,
    "expected_current_revision_id",
  );
  const approvalKey = "approve-reserved-legality-relationship-over-budget";
  const revisionId = await catalogueRevisionIdentity({
    runId: run.id,
    candidateDigest: digest,
    expectedCurrentRevisionId: expectedRevision,
  });
  const approvalRequest = {
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
    idempotency_key: approvalKey,
  };
  const approval = {
    action: "approved",
    approved_at: "2026-07-29T02:00:00.000Z",
    candidate_digest: digest,
    expected_current_revision_id: expectedRevision,
  };
  await testEnv.CATALOGUE_DB.prepare(
    `UPDATE ingestion_runs
     SET state = 'publishing',
         approval_json = ?,
         approval_idempotency_key = ?,
         approval_history_json = ?,
         progress_json = ?,
         publication_revision_id = ?,
         publication_started_at = ?,
         publication_reconcile_after = ?,
         publication_manifest_digest = ?,
         publication_writer_token = ?
     WHERE id = ? AND state = 'awaiting_approval'`,
  )
    .bind(
      JSON.stringify(approval),
      approvalKey,
      JSON.stringify([approval]),
      JSON.stringify({
        completed_stages: [
          "planning",
          "collecting",
          "parsing",
          "reconciling",
          "awaiting_approval",
        ],
        current_stage: "publishing",
      }),
      revisionId,
      approval.approved_at,
      "2026-07-29T02:05:00.000Z",
      "a".repeat(64),
      `writer:${revisionId}`,
      run.id,
    )
    .run();
  const currentBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first<{ current_revision_id: string }>();
  const revisionsBefore = await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first<{ count: number }>();
  const objectsBefore = (await testEnv.CATALOGUE_EXPORTS.list())
    .objects.map((object) => object.key).sort();

  const blocked = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    approvalRequest,
  );
  expect(blocked.response.status).toBe(422);
  expect(blocked.document).toMatchObject({
    code: "catalogue_export_too_large",
  });
  const shown = await get(`/v1/ingestion-runs/${run.id}`);
  expect(shown.document).toMatchObject({
    state: "failed",
    failure_code: "catalogue_export_too_large",
  });
  const lifecycle = await testEnv.CATALOGUE_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT COUNT(*) FROM administration_idempotency
        WHERE idempotency_key = ?
          AND operation = 'approve_ingestion_run'
          AND outcome = 'problem' AND http_status = 422) AS outcomes,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id,
       (SELECT state FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanup_state,
       (SELECT object_keys_json FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanup_keys`,
  )
    .bind(approvalKey, approvalKey, run.id, run.id)
    .first<{
      claims: number;
      outcomes: number;
      active_ingestion_run_id: string | null;
      cleanup_state: string;
      cleanup_keys: string;
    }>();
  expect(lifecycle).toEqual({
    claims: 0,
    outcomes: 1,
    active_ingestion_run_id: null,
    cleanup_state: "pending",
    cleanup_keys: "[]",
  });

  const replay = await post(
    `/v1/ingestion-runs/${run.id}/approval`,
    approvalRequest,
  );
  expect(replay.response.status).toBe(422);
  expect(replay.document).toMatchObject({
    code: blocked.document.code,
    detail: blocked.document.detail,
    status: blocked.document.status,
    type: blocked.document.type,
  });
  expect((await testEnv.CATALOGUE_EXPORTS.list()).objects
    .map((object) => object.key).sort()).toEqual(objectsBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT current_revision_id FROM catalogue_state WHERE singleton = 1`,
  ).first()).toEqual(currentBefore);
  expect(await testEnv.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM catalogue_revisions`,
  ).first()).toEqual(revisionsBefore);
});

async function collect(
  path: string,
  key: string,
  source?: { game: string; lineage: string; adapter: string },
  waitTimeoutMs = 15_000,
): Promise<{
  id: string;
  document: Record<string, unknown>;
}> {
  const started = await postFixtureEvidence({
    supported_game: source?.game ?? "one-piece",
    source_lineage: source?.lineage ?? "one-piece-en",
    adapter_version: source?.adapter ?? "fixture-one-piece-json@1",
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
  const document = await waitForRunState(id, "parsing", waitTimeoutMs);
  return { id, document };
}

function officialGundamUrl(
  lineage: "gundam-en-asia" | "gundam-en-us",
  surface: string,
): string {
  const base = lineage === "gundam-en-asia"
    ? "https://www.gundam-gcg.com/asia-en"
    : "https://www.gundam-gcg.com/en";
  const paths: Record<string, string> = {
    packages: "/cards/index.php",
    products: "/products/list.php",
    releases: "/products/list.php",
    legality: "/rules/",
    errata: "/news/?subcategory=rules",
  };
  return `${base}${paths[surface]}`;
}

async function collectRequests(
  requests: readonly { id: string; scenario: string }[],
  key: string,
): Promise<{ id: string; document: Record<string, unknown> }> {
  const started = await postFixtureEvidence({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: key,
    requests: requests.map((request) => ({
      id: request.id,
      method: "GET" as const,
      url: `https://official-source.invalid/reconciliation/${request.scenario}`,
      headers: { accept: "application/json" },
    })),
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  return { id, document: await waitForRunState(id, "parsing") };
}

async function expectRetainedEvidenceInvalid(
  runId: string,
  detail: string,
): Promise<void> {
  const blocked = await reconcile(runId);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(detail),
      }),
    ],
  });
}

async function waitForRunState(
  id: string,
  expectedState: string,
  timeoutMs = 15_000,
  pollIntervalMs = 25,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    if (shown.document.state === expectedState) {
      return shown.document;
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`run ${id} did not reach ${expectedState}`);
}

async function reconcile(
  runId: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 15_000,
) {
  const shown = await get(`/v1/ingestion-runs/${runId}`);
  const expectedCurrentRevisionId = requiredString(
    shown.document,
    "expected_current_revision_id",
  );
  const body = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await post(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      body,
      extraHeaders,
    );
    if (
      observed.response.status !== 200 &&
      observed.response.status !== 202
    ) {
      return observed;
    }
    if (
      observed.document.status === "complete" &&
      observed.document.output !== null &&
      typeof observed.document.output === "object" &&
      !Array.isArray(observed.document.output)
    ) {
      const document = observed.document.output as Record<string, unknown>;
      return {
        response: new Response(null, {
          status: document.publishable === true ? 200 : 409,
        }),
        document,
        workflow_instance_id: requiredString(
          observed.document,
          "workflow_instance_id",
        ),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reconciliation Workflow ${runId} did not complete`);
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

function post(
  pathname: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return request(pathname, body, extraHeaders);
}

async function postFixtureEvidence(body: StartEvidenceRunRequest) {
  const document = await injectFixtureEvidencePlan(
    testEnv.CATALOGUE_DB,
    body,
  );
  return {
    response: new Response(null, { status: 201 }),
    document,
  };
}

async function request(
  pathname: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const rpcResponse = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(requestSequence++ % 250) + 1}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const status = rpcResponse.status;
  const document =
    (await rpcResponse.json()) as Record<string, unknown>;
  return {
    response: new Response(null, { status }),
    document,
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

function requiredObjectWithField(
  document: Record<string, unknown>,
  collectionField: string,
  valueField: string,
  expectedValue: unknown,
): Record<string, unknown> {
  const values = document[collectionField];
  if (!Array.isArray(values)) {
    throw new Error(`${collectionField} is not an array`);
  }
  const value = values.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>)[valueField] === expectedValue,
  );
  if (value === undefined) {
    throw new Error(
      `${collectionField} has no object with ${valueField}=${String(expectedValue)}`,
    );
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

function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

async function exportComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  const manifest = await manifestObject?.json<{
    components: {
      name: string;
      compressed_sha256: string;
    }[];
  }>();
  const component = manifest?.components.find(
    (candidate) => candidate.name === componentName,
  );
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component?.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("export component missing");
  const decompressed = object.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const text = await new Response(decompressed).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function exportManifest(revisionId: string): Promise<{
  published_at: string;
  source_freshness: {
    game: string;
    area: string;
    checked_at: string;
  }[];
  components: {
    name: string;
    uncompressed_bytes: number;
    compressed_bytes: number;
    compressed_sha256: string;
  }[];
}> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  if (manifestObject === null) throw new Error("export manifest missing");
  return manifestObject.json();
}
