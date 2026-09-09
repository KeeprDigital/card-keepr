import { expect, test } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import worker from "../src/index";
import { runReconciliationWorkflow as runShippedWorkflow } from "../src/reconciliation-workflow";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { reconciliationBindingObserver, type BindingObservation } from "./reconciliation-binding-observer";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test.for(["normal", "lost response"])(
  "collection-root notification preserves its receipt and replay (%s)",
  async (boundary, { task }) => {
    const caseKey = `collection-notification-${boundary.replaceAll(" ", "-")}`;
    const source = await collect("/reconciliation/base", caseKey);
    let params: ReconciliationWorkflowParams | undefined;
    const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
    const created = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/game-candidates", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({
          ingestion_run_id: source.id,
          supported_game: "one-piece",
          expected_game_revision_id: "catrev_spine_000",
          idempotency_key: `${caseKey}-candidate`,
        }),
      }),
      {
        ...testEnv,
        RECONCILIATION_WORKFLOW: {
          create: async (options: { params: ReconciliationWorkflowParams }) => {
            params = options.params;
            return queued;
          },
          get: async () => queued,
        } as unknown as Env["RECONCILIATION_WORKFLOW"],
      },
    );
    expect(created.status).toBe(201);
    const candidateId = requiredString(await created.json<Record<string, unknown>>(), "id");
    expect(params).toBeDefined();
    const seed = await runReconciliationWorkflow(
      testEnv,
      { instanceId: `${caseKey}-seed`, payload: params! } as WorkflowEvent<ReconciliationWorkflowParams>,
      {
        do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
      } as unknown as WorkflowStep,
    );
    const status = (await get(`/v1/game-candidates/${candidateId}`)).document;
    expect(status.state).toBe("sealed");
    const records = await nativeCandidateRecords(candidateId);
    const observer = reconciliationBindingObserver();
    const observations: (BindingObservation & { name: string })[] = [];
    const rootId = `${caseKey}-root`;
    const rootLookups: string[] = [];
    const accepted: { type: string; payload: unknown }[] = [];
    const lostResponse = new Error("Injected accepted notification response loss");
    const instance = {
      sendEvent: (event: { type: string; payload: unknown }) =>
        observer.driverMethod("collection.sendEvent", async () => {
          accepted.push(structuredClone(event));
          if (boundary === "lost response" && accepted.length === 1) throw lostResponse;
        }),
    } as unknown as WorkflowInstance;
    const binding = {
      get: (id: string) =>
        observer.driverMethod("collection.get", async () => {
          rootLookups.push(id);
          return instance;
        }),
    } as unknown as Env["EVIDENCE_INGESTION_WORKFLOW"];
    const environment = {
      ...testEnv,
      CATALOGUE_DB: observer.database(testEnv.CATALOGUE_DB),
      EVIDENCE_OBJECTS: observer.bucket(testEnv.EVIDENCE_OBJECTS, "EVIDENCE_OBJECTS"),
      PRINTING_IMAGES: observer.bucket(testEnv.PRINTING_IMAGES, "PRINTING_IMAGES"),
      EVIDENCE_INGESTION_WORKFLOW: binding,
    };
    const event = {
      instanceId: `${caseKey}-terminal-shard`,
      payload: { ...params!, shard: { ordinal: 0, root: { binding: "collection", id: rootId } } },
    } as WorkflowEvent<ReconciliationWorkflowParams>;
    const step = {
      do: async (name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          const scope = observer.begin();
          try {
            return await callback();
          } catch (error) {
            expect(error).toBe(lostResponse);
            if (attempt >= config.retries.limit) throw error;
          } finally {
            observations.push({ name, ...scope });
            observer.end();
          }
        }
      },
    } as unknown as WorkflowStep;
    try {
      // Simulated collection receiver; method outcomes are not hosted delivery or exactly-once evidence.
      const delivered = await runShippedWorkflow(environment, event, step);
      expect(delivered).toEqual(seed);
      expect(accepted).toHaveLength(boundary === "normal" ? 1 : 2);
      expect(await runShippedWorkflow(environment, event, step)).toEqual(seed);
      const expectedDeliveries = boundary === "normal" ? 2 : 3;
      expect(accepted).toHaveLength(expectedDeliveries);
      expect(rootLookups).toEqual(Array(expectedDeliveries).fill(rootId));
      expect(
        accepted.every((message) => message.type === "reconciliation-terminal" && message.payload === seed.result_json),
      ).toBe(true);
      expect((await get(`/v1/game-candidates/${candidateId}`)).document).toEqual(status);
      expect(await nativeCandidateRecords(candidateId)).toEqual(records);
      const notifications = observations.filter((scope) => scope.methods["Workflow.driver.collection.get"]);
      expect(notifications).toHaveLength(expectedDeliveries);
      expect(notifications.every((scope) => scope.calls === 2)).toBe(true);
      expect(
        notifications.reduce((sum, scope) => sum + scope.outcomes["Workflow.driver.collection.sendEvent"]!.rejected, 0),
      ).toBe(boundary === "normal" ? 0 : 1);
      expect(
        notifications.reduce(
          (sum, scope) => sum + scope.outcomes["Workflow.driver.collection.sendEvent"]!.fulfilled,
          0,
        ),
      ).toBe(2);
      expect(observations.every(({ calls }) => calls <= 100)).toBe(true);
    } finally {
      Object.assign(task.meta, {
        reconciliationBindingReport: {
          contract: "card-keepr-local-reconciliation-callbacks@2",
          workload: `tiny collection-root notification: ${boundary}`,
          limitation:
            "Shipped terminal notification branch with simulated collection get/sendEvent receiver; repeated accepted payloads are not exactly-once hosted delivery. Setup, status/partition verification and publication are outside observation. No IDs, payloads or row data retained.",
          accepted_deliveries: accepted.length,
          callbacks: observations,
          outside_callbacks: observer.outsideCallbacks,
        },
      });
    }
  },
);
