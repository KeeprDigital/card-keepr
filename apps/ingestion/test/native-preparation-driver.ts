import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CatalogueBackupWorkflowParams } from "../../../src/catalogue/backup-recovery";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runCatalogueBackupWorkflow } from "../src/backup-workflow";
import { runReconciliationWorkflow as runNativeWorkflow } from "../src/reconciliation-workflow";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

type Pending =
  | { kind: "reconciliation"; id: string; params: ReconciliationWorkflowParams }
  | { kind: "backup"; id: string; params: CatalogueBackupWorkflowParams };

/** Control scheduling at the existing Workflow entrypoints, retaining real owner, D1/R2 and SQL restore work. */
export function nativePreparationDriver(env: Env, scope: "preparation" | "native-owner" = "preparation") {
  const pending: Pending[] = [];
  const states = new Map<string, "queued" | "running" | "complete" | "errored">();
  const instance = (id: string) => ({ id, status: async () => ({ status: states.get(id)! }) }) as WorkflowInstance;
  function enqueue(work: Pending) {
    if (states.has(work.id)) throw new Error("instance.already_exists");
    states.set(work.id, "queued");
    pending.push(work);
    return instance(work.id);
  }
  const binding = new Proxy(env.RECONCILIATION_WORKFLOW, {
    get(target, property) {
      if (property === "create")
        return async (options: { id: string; params: ReconciliationWorkflowParams }) => {
          const preparation =
            options.params.preparation_id && !options.params.publication && !options.params.publication_preparation;
          const publication = options.params.publication || options.params.publication_preparation;
          if (!preparation && !(scope === "native-owner" && publication)) {
            if (scope === "native-owner")
              throw new Error("A controlled native-owner fixture cannot dispatch an unrelated background Workflow.");
            return target.create(options);
          }
          return enqueue({ kind: "reconciliation", ...options });
        };
      if (property === "get") return async (id: string) => (states.has(id) ? instance(id) : target.get(id));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const backups = new Proxy(env.CATALOGUE_BACKUP_WORKFLOW, {
    get(target, property) {
      if (property === "create")
        return async (options: { id: string; params: CatalogueBackupWorkflowParams }) => {
          if (scope !== "native-owner") return target.create(options);
          return enqueue({ kind: "backup", ...options });
        };
      if (property === "get") return async (id: string) => (states.has(id) ? instance(id) : target.get(id));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const environment = { ...env, RECONCILIATION_WORKFLOW: binding, CATALOGUE_BACKUP_WORKFLOW: backups };
  return {
    environment,
    async drain() {
      for (let work = pending.shift(); work; work = pending.shift()) {
        states.set(work.id, "running");
        const step = {
          do: async (_name: string, config: unknown, callback: () => Promise<unknown>) => {
            // No scheduling delays or test-level retries. Production failure handlers still run.
            return (typeof config === "function" ? config : callback)();
          },
        } as unknown as WorkflowStep;
        try {
          if (work.kind === "backup") {
            await runCatalogueBackupWorkflow(
              environment,
              {
                instanceId: work.id,
                payload: work.params,
                timestamp: new Date(),
              } as WorkflowEvent<CatalogueBackupWorkflowParams>,
              step,
            );
          } else {
            const run =
              work.params.publication || work.params.publication_preparation
                ? runNativeWorkflow
                : runReconciliationWorkflow;
            await run(
              environment,
              {
                instanceId: work.id,
                payload: work.params,
                timestamp: new Date(),
              } as WorkflowEvent<ReconciliationWorkflowParams>,
              step,
            );
          }
          states.set(work.id, "complete");
        } catch (error) {
          states.set(work.id, "errored");
          throw error;
        }
      }
    },
  };
}
