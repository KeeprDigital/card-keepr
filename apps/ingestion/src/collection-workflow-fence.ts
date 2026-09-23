import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { CatalogueStore } from "../../../src/catalogue/shared";
import { isCurrentCollectionWorkflowAttempt } from "../../../src/catalogue/source-evidence";

const supersededName = "SupersededCollectionWorkflowAttempt";

/** A replayed step result is never permission for a superseded attempt to act. */
export function fenceCollectionWorkflow(
  step: WorkflowStep,
  database: CatalogueStore,
  runId: string,
  parentId: string,
  instanceId: string,
): WorkflowStep {
  const assertCurrent = async () => {
    if (!(await isCurrentCollectionWorkflowAttempt(database, runId, parentId, instanceId))) {
      throw new NonRetryableError("The collection Workflow Attempt has been superseded.", supersededName);
    }
  };
  // Replay is a prefix of each invocation: one check before its first step
  // fences every replayed result, and once a callback has run live every
  // later step is checked as before. Checking before each replayed step made
  // replay cost one query per retained step, unbounded in one invocation (#327).
  let replayFenced = false,
    live = false;
  return new Proxy(step, {
    get(target, property) {
      if (property === "do") {
        return async (name: string, configOrCallback: unknown, possibleCallback?: unknown) => {
          if (live || !replayFenced) {
            await assertCurrent();
            replayFenced = true;
          }
          const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const fenced = async (...args: unknown[]) => {
            live = true;
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
