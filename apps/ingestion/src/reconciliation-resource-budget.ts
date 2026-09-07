import type { WorkflowStep } from "cloudflare:workers";
import { ReconciliationDocumentStorageError } from "../../../src/catalogue/reconciliation";

const bounded = Symbol("bounded reconciliation callbacks");
type Budget = {
  calls: number;
  streams: number;
  pending: Set<Promise<unknown>>;
  close: Set<() => Promise<void>>;
};

/** Resource exhaustion is retryable; it must never masquerade as invalid source data. */
function exhausted(message: string): never {
  const error = new ReconciliationDocumentStorageError(new Error(message));
  error.message = message;
  throw error;
}

/** The callback owns all binding calls and R2 bodies, including retry attempts. */
export function boundedReconciliationResources(env: Env, step: WorkflowStep): { env: Env; step: WorkflowStep } {
  if (Reflect.get(step, bounded)) return { env, step };
  let active: Budget | undefined;
  const charge = () => {
    if (!active) return;
    if (active.calls === 100) exhausted("Reconciliation callback exceeds 100 calls.");
    active.calls++;
  };
  const originals = new WeakMap<object, D1PreparedStatement>();
  const statement = (original: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "bind") return (...args: unknown[]) => statement(target.bind(...args));
        if (["run", "first", "all", "raw"].includes(String(property)))
          return (...args: unknown[]) => {
            charge();
            return Reflect.apply(value, target, args);
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
      const value = Reflect.get(target, property, target);
      if (property === "exec")
        return (...args: unknown[]) => {
          charge();
          return Reflect.apply(value, target, args);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bucket = (original: R2Bucket) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "get")
          return (...args: unknown[]) => {
            charge();
            return Reflect.apply(value, target, args);
          };
        return (...args: unknown[]) => {
          const budget = active;
          if (budget && budget.streams === 4) exhausted("Reconciliation callback exceeds four open R2 bodies.");
          charge();
          if (!budget) return Reflect.apply(value, target, args);
          budget.streams++;
          const operation = (async () => {
            let released = false;
            let close: (() => Promise<void>) | undefined;
            const release = () => {
              if (released) return;
              released = true;
              budget.streams--;
              if (close) budget.close.delete(close);
            };
            try {
              const result = (await Reflect.apply(value, target, args)) as R2ObjectBody | R2Object | null;
              if (!result || !("body" in result)) {
                release();
                return result;
              }
              let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
              let stream: ReadableStream<Uint8Array> | undefined;
              close = async () => {
                try {
                  await (reader ? reader.cancel() : result.body.cancel());
                } finally {
                  release();
                }
              };
              budget.close.add(close);
              return new Proxy(result, {
                get(target, property) {
                  if (property === "body") {
                    stream ??= new ReadableStream<Uint8Array>({
                      async pull(controller) {
                        try {
                          reader ??= target.body.getReader();
                          const chunk = await reader.read();
                          if (chunk.done) {
                            release();
                            controller.close();
                          } else controller.enqueue(chunk.value);
                        } catch (error) {
                          release();
                          controller.error(error);
                        }
                      },
                      cancel: close,
                    });
                    return stream;
                  }
                  const value = Reflect.get(target, property, target);
                  if (["text", "json", "arrayBuffer", "blob", "bytes"].includes(String(property)))
                    return async (...args: unknown[]) => {
                      try {
                        return await Reflect.apply(value, target, args);
                      } finally {
                        release();
                      }
                    };
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
            } catch (error) {
              release();
              throw error;
            }
          })();
          budget.pending.add(operation);
          void operation.then(
            () => budget.pending.delete(operation),
            () => budget.pending.delete(operation),
          );
          return operation;
        };
      },
    });
  const instance = (original: WorkflowInstance) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (...args: unknown[]) => {
              charge();
              return Reflect.apply(value, target, args);
            }
          : value;
      },
    });
  const workflow = <T>(original: Workflow<T>) =>
    new Proxy(original, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          charge();
          const result = await Reflect.apply(value, target, args);
          return Array.isArray(result)
            ? result.map(instance)
            : result !== null && typeof result === "object" && "status" in result
              ? instance(result as WorkflowInstance)
              : result;
        };
      },
    });
  return {
    env: {
      ...env,
      CATALOGUE_DB: database,
      EVIDENCE_OBJECTS: bucket(env.EVIDENCE_OBJECTS),
      PRINTING_IMAGES: bucket(env.PRINTING_IMAGES),
      RECONCILIATION_WORKFLOW: workflow(env.RECONCILIATION_WORKFLOW),
      EVIDENCE_INGESTION_WORKFLOW: workflow(env.EVIDENCE_INGESTION_WORKFLOW),
    },
    step: new Proxy(step, {
      get(target, property) {
        if (property === bounded) return true;
        const value = Reflect.get(target, property, target);
        if (property !== "do") return typeof value === "function" ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const callback = args.at(-1) as (...args: unknown[]) => Promise<unknown>;
          args[args.length - 1] = async (...context: unknown[]) => {
            if (active) throw new Error("Reconciliation callbacks must run sequentially.");
            const budget: Budget = { calls: 0, streams: 0, pending: new Set(), close: new Set() };
            active = budget;
            try {
              return await callback(...context);
            } finally {
              await Promise.allSettled(budget.pending);
              await Promise.allSettled([...budget.close].map((close) => close()));
              active = undefined;
            }
          };
          return Reflect.apply(value, target, args);
        };
      },
    }),
  };
}
