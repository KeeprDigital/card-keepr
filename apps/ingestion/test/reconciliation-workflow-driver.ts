import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import { runReconciliationWorkflow as runWorkflow } from "../src/reconciliation-workflow";

/** Drive the Workflow control-plane boundary in-process so D1/R2 fault probes see every shard. */
export async function runReconciliationWorkflow(
  env: Env,
  event: Readonly<WorkflowEvent<ReconciliationWorkflowParams>>,
  step: WorkflowStep,
  trace?: {
    callbacks: Map<string, number>;
    created: string[];
    loseCreateResponse?: boolean;
    observeMethod?: <T>(method: string, operation: () => Promise<T>) => Promise<T>;
    observeEvent?: (method: string) => void;
  },
) {
  const rootId = event.instanceId ?? `direct-${event.payload.ingestion_run_id}`;
  const pending: { id: string; params: ReconciliationWorkflowParams }[] = [];
  const states = new Map<string, string>([[rootId, "running"]]);
  const messages = new Map<string, unknown>();
  let activeId = rootId;
  let lostCreateResponse = false;
  const observe = <T>(method: string, operation: () => Promise<T>) =>
    trace?.observeMethod ? trace.observeMethod(method, operation) : operation();
  function instance(id: string) {
    if (!states.has(id)) throw new Error("instance.not_found");
    return {
      id,
      status: () => observe("status", async () => ({ status: states.get(id)! })),
      sendEvent: (message: { type: string; payload: unknown }) =>
        observe("sendEvent", async () => {
          messages.set(message.type, message.payload);
        }),
    } as WorkflowInstance;
  }
  const binding = new Proxy(env.RECONCILIATION_WORKFLOW, {
    get(target, property) {
      if (property === "get") return (id: string) => observe("get", async () => instance(id));
      if (property === "create")
        return (options: { id: string; params: ReconciliationWorkflowParams }) =>
          observe("create", async () => {
            if (states.has(options.id)) throw new Error("instance.already_exists");
            states.set(options.id, "queued");
            pending.push(options);
            trace?.created.push(options.id);
            if (trace?.loseCreateResponse && !lostCreateResponse) {
              lostCreateResponse = true;
              throw new Error("Injected lost Workflow create response.");
            }
            return instance(options.id);
          });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const environment = { ...env, RECONCILIATION_WORKFLOW: binding };
  const steps = new Proxy(step, {
    get(target, property) {
      if (property === "do")
        return (name: string, config: unknown, callback: (...args: unknown[]) => unknown) => {
          const observed = (...args: unknown[]) => {
            if (name.startsWith("reconcile retained Card, Printing, and Erratum evidence"))
              trace?.callbacks.set(activeId, (trace.callbacks.get(activeId) ?? 0) + 1);
            return callback(...args);
          };
          return Reflect.apply(target.do, target, [name, config, observed]);
        };
      if (property === "waitForEvent")
        return async (_name: string, options: { type: string }) => {
          trace?.observeEvent?.("waitForEvent");
          while (!messages.has(options.type)) {
            const child = pending.shift();
            if (!child) throw new Error("No dispatched Workflow can deliver the terminal event.");
            states.set(child.id, "running");
            activeId = child.id;
            await runWorkflow(
              environment,
              {
                ...event,
                instanceId: child.id,
                payload: child.params,
              },
              steps,
            );
            states.set(child.id, "complete");
            activeId = rootId;
          }
          return { payload: messages.get(options.type), type: options.type, timestamp: new Date() };
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return runWorkflow(environment, { ...event, instanceId: rootId }, steps);
}
