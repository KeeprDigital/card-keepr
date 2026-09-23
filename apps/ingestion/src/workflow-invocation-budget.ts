import type { WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";

/**
 * Workers count subrequests (D1, R2, Workflow and service calls) per
 * invocation, and a Workflow engine lifetime is one invocation that runs every
 * step back to back until the engine goes idle. Collection Workflows chain
 * hundreds of bounded steps, so a per-step bound alone does not bound the
 * invocation (#327: the parent barrier died at 5,000). This wrapper counts the
 * binding calls made during the current invocation and, once they reach the
 * budget, issues a durable sleep longer than the engine's idle grace period
 * (5 minutes in workflows-shared) so the engine hibernates and the next step
 * starts a fresh invocation. Replayed step results make no binding calls and
 * issue no yield, so replay never repeats a yield.
 *
 * CPU is charged the same way, and the two do not move together. Archive
 * decoding inflates and hashes in JavaScript across steps that make only a
 * handful of binding calls each, so a subrequest budget alone never yields for
 * them: the #327 live run spent 177 subrequests over an entire collection
 * while one archive would have spent tens of CPU-seconds in a single engine
 * lifetime. Live steps are therefore counted as well, because every step in
 * these Workflows already declares a bounded window of work, which makes a
 * step count a usable stand-in for the CPU no Workers API exposes.
 */
export const workflowInvocationSubrequestBudget = 5000;
/**
 * Live steps one invocation may run before hibernating, for the Workflows that
 * run archive steps. The costliest bounded step (an archive decode) inflates
 * and hashes about 4 MiB, measured at ~0.15 s of isolate CPU; this keeps an
 * engine lifetime near a third of the deployed 30 s ceiling even if production
 * hardware is several times slower. A Workflow whose steps only wait on
 * bindings leaves `steps` unset: hibernating a cheap poll costs six minutes of
 * wall time and saves no CPU, and its invocation is already bounded by the
 * subrequest budget.
 */
export const workflowInvocationStepBudget = 24;

export type WorkflowWaitMode = "production" | "immediate";

/** Test harnesses opt into "immediate" waits; any other value fails closed. */
export function workflowWaitMode(value: string | undefined): WorkflowWaitMode {
  if (value === undefined || value === "production") return "production";
  if (value === "immediate") return "immediate";
  throw new Error(`WORKFLOW_WAIT_MODE must be "production" or "immediate", got ${JSON.stringify(value)}.`);
}

export function workflowYieldDuration(mode: WorkflowWaitMode): WorkflowSleepDuration {
  return mode === "immediate" ? "1 second" : "6 minutes";
}

export type InvocationUsage = Readonly<{ subrequests: number; steps: number; yields: number }>;

type Bindings = Pick<
  Env,
  | "CATALOGUE_DB"
  | "EVIDENCE_OBJECTS"
  | "PRINTING_IMAGES"
  | "CATALOGUE_EXPORTS"
  | "BACKUPS"
  | "EVIDENCE_INGESTION_WORKFLOW"
  | "EVIDENCE_HOST_WORKFLOW"
  | "RECONCILIATION_WORKFLOW"
  | "CATALOGUE_BACKUP_WORKFLOW"
  | "OFFICIAL_SOURCE_TRANSPORT"
>;

/** Count every binding call; wrap returned statements, uploads and instances too. */
export function boundedWorkflowInvocation<Environment extends Bindings>(
  env: Environment,
  step: WorkflowStep,
  options: {
    mode: WorkflowWaitMode;
    budget?: number;
    steps?: number;
    // Observes each live callback's subrequests (structure tests).
    observe?: (name: string, subrequests: number) => void;
  },
): { env: Environment; step: WorkflowStep; usage: () => InvocationUsage } {
  const budget = options.budget ?? workflowInvocationSubrequestBudget;
  const stepBudget = options.steps ?? Number.POSITIVE_INFINITY;
  let subrequests = 0,
    sinceYield = 0,
    steps = 0,
    stepsSinceYield = 0,
    yields = 0,
    active = 0;
  const charge = () => {
    subrequests++;
    sinceYield++;
  };
  const counted = <T extends object>(target: T, wrap: (value: unknown) => unknown = (value) => value): T =>
    new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object) as unknown;
        if (typeof value !== "function" || typeof property !== "string" || property === "then") return value;
        return (...args: unknown[]) => {
          charge();
          const result = Reflect.apply(value, object, args) as unknown;
          return result instanceof Promise ? result.then(wrap) : wrap(result);
        };
      },
    });
  const originals = new WeakMap<object, D1PreparedStatement>();
  const statement = (original: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (typeof value === "function" && ["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            charge();
            return Reflect.apply(value, target, args) as unknown;
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(wrapped, original);
    return wrapped;
  };
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          charge();
          return target.batch(statements.map((entry) => originals.get(entry) ?? entry));
        };
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (property === "exec" || property === "dump")
        return (...args: unknown[]) => {
          charge();
          return Reflect.apply(value, target, args) as unknown;
        };
      return value.bind(target);
    },
  });
  const upload = (value: unknown) =>
    value !== null && typeof value === "object" && "uploadPart" in value ? counted(value) : value;
  const instance = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(instance)
      : value !== null && typeof value === "object" && "status" in value
        ? counted(value)
        : value;
  const boundedEnv = {
    ...env,
    CATALOGUE_DB: database,
    EVIDENCE_OBJECTS: counted(env.EVIDENCE_OBJECTS, upload),
    PRINTING_IMAGES: counted(env.PRINTING_IMAGES, upload),
    CATALOGUE_EXPORTS: counted(env.CATALOGUE_EXPORTS, upload),
    BACKUPS: counted(env.BACKUPS, upload),
    EVIDENCE_INGESTION_WORKFLOW: counted(env.EVIDENCE_INGESTION_WORKFLOW, instance),
    EVIDENCE_HOST_WORKFLOW: counted(env.EVIDENCE_HOST_WORKFLOW, instance),
    RECONCILIATION_WORKFLOW: counted(env.RECONCILIATION_WORKFLOW, instance),
    CATALOGUE_BACKUP_WORKFLOW: counted(env.CATALOGUE_BACKUP_WORKFLOW, instance),
    OFFICIAL_SOURCE_TRANSPORT: counted(env.OFFICIAL_SOURCE_TRANSPORT),
  } as Environment;
  const boundedStep = new Proxy(step, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      // The step is an RPC stub: forward calls without touching `bind` on it.
      if (property !== "do")
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      return async (name: string, ...args: unknown[]) => {
        const callback = args.at(-1) as (...context: unknown[]) => Promise<unknown>;
        let live = false,
          before = 0;
        args[args.length - 1] = async (...context: unknown[]) => {
          live = true;
          before = subrequests;
          try {
            return await callback(...context);
          } finally {
            options.observe?.(name, subrequests - before);
          }
        };
        active++;
        let result: unknown;
        try {
          result = await Reflect.apply(target.do, target, [name, ...args]);
        } finally {
          active--;
        }
        if (live) {
          steps++;
          stepsSinceYield++;
        }
        if (live && active === 0 && (sinceYield >= budget || stepsSinceYield >= stepBudget)) {
          sinceYield = 0;
          stepsSinceYield = 0;
          yields++;
          await target.sleep(
            `yield Workflow invocation after ${name.slice(0, 200)}`,
            workflowYieldDuration(options.mode),
          );
        }
        return result;
      };
    },
  });
  return { env: boundedEnv, step: boundedStep, usage: () => ({ subrequests, steps, yields }) };
}
