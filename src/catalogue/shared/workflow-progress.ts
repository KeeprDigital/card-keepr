import type { WorkflowStep } from "cloudflare:workers";

export type WorkflowProgress = Readonly<{
  name: string;
  phase: "started" | "completed" | "failed";
  at: string;
}>;

/** Record actual callback execution, never a replayed step result or an administration poll. */
export function observeWorkflowProgress(
  step: WorkflowStep,
  record: (progress: WorkflowProgress) => Promise<void>,
): WorkflowStep {
  return new Proxy(step, {
    get(target, property) {
      if (property !== "do") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      }
      return (name: string, configOrCallback: unknown, possibleCallback?: unknown) => {
        const callback = (typeof configOrCallback === "function" ? configOrCallback : possibleCallback) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        const wrapped = async (...args: unknown[]) => {
          await record({ name, phase: "started", at: new Date().toISOString() });
          let result: unknown;
          try {
            result = await callback(...args);
          } catch (error) {
            await record({ name, phase: "failed", at: new Date().toISOString() });
            throw error;
          }
          await record({ name, phase: "completed", at: new Date().toISOString() });
          return result;
        };
        return typeof configOrCallback === "function"
          ? Reflect.apply(target.do, target, [name, wrapped])
          : Reflect.apply(target.do, target, [name, configOrCallback, wrapped]);
      };
    },
  });
}
