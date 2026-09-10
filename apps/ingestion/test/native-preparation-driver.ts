import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

/** Semantic fixtures retain the real owner and D1/R2 work while controlling preparation scheduling. */
export function nativePreparationDriver(env: Env) {
  const pending: { id: string; params: ReconciliationWorkflowParams }[] = [];
  const states = new Map<string, "queued" | "running" | "complete" | "errored">();
  const instance = (id: string) => ({ id, status: async () => ({ status: states.get(id)! }) }) as WorkflowInstance;
  const binding = new Proxy(env.RECONCILIATION_WORKFLOW, {
    get(target, property) {
      if (property === "create")
        return async (options: { id: string; params: ReconciliationWorkflowParams }) => {
          if (!options.params.preparation_id || options.params.publication || options.params.publication_preparation)
            return target.create(options);
          if (states.has(options.id)) throw new Error("instance.already_exists");
          states.set(options.id, "queued");
          pending.push(options);
          return instance(options.id);
        };
      if (property === "get") return async (id: string) => (states.has(id) ? instance(id) : target.get(id));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const environment = { ...env, RECONCILIATION_WORKFLOW: binding };
  return {
    environment,
    async drain() {
      for (let work = pending.shift(); work; work = pending.shift()) {
        states.set(work.id, "running");
        const step = {
          do: async (_name: string, config: unknown, callback: () => Promise<unknown>) => {
            // Failures propagate; this scheduling fixture does not retry failed assertions or operations.
            return (typeof config === "function" ? config : callback)();
          },
        } as unknown as WorkflowStep;
        try {
          await runReconciliationWorkflow(
            environment,
            {
              instanceId: work.id,
              payload: work.params,
              timestamp: new Date(),
            } as WorkflowEvent<ReconciliationWorkflowParams>,
            step,
          );
          states.set(work.id, "complete");
        } catch (error) {
          states.set(work.id, "errored");
          throw error;
        }
      }
    },
  };
}
