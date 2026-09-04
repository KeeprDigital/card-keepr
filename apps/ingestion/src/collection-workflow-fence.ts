import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { isCurrentCollectionWorkflowAttempt } from "../../../src/catalogue/source-evidence";

const supersededName = "SupersededCollectionWorkflowAttempt";

/** A replayed step result is never permission for a superseded attempt to act. */
export function fenceCollectionWorkflow(
  step: WorkflowStep,
  database: D1Database,
  runId: string,
  parentId: string,
  instanceId: string,
): WorkflowStep {
  const assertCurrent = async () => {
    if (!(await isCurrentCollectionWorkflowAttempt(database, runId, parentId, instanceId))) {
      throw new NonRetryableError("The collection Workflow Attempt has been superseded.", supersededName);
    }
  };
  return new Proxy(step, {
    get(target, property) {
      if (property === "do") {
        return async (name: string, configOrCallback: unknown, possibleCallback?: unknown) => {
          await assertCurrent();
          const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const fenced = async (...args: unknown[]) => {
            // This runs again on an actual durable callback retry, including
            // a retry restored after the run has paused and resumed.
            await assertCurrent();
            return callback(...args);
          };
          return typeof configOrCallback === "function"
            ? Reflect.apply(target.do, target, [name, fenced])
            : Reflect.apply(target.do, target, [name, configOrCallback, fenced]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
    },
  });
}

export function isSupersededCollectionWorkflow(error: unknown): boolean {
  return error instanceof Error && error.name === supersededName;
}
