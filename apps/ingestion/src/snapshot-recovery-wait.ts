import type { WorkflowStep } from "cloudflare:workers";
import { catalogueMutationFenced } from "../../../src/catalogue/backup-recovery";
import { catalogueStore } from "../../../src/catalogue/shared";

/** A database fence is an external wait, not a failed collection or a new approval. */
export function snapshotRecoveryWait(env: Env, step: WorkflowStep): WorkflowStep {
  return new Proxy(step, {
    get(target, property) {
      if (property !== "do") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      }
      return async (name: string, ...args: unknown[]) => {
        for (let generation = 0; ; generation++) {
          try {
            return await Reflect.apply(target.do, target, [
              generation === 0 ? name : `${name} after recovery ${generation}`,
              ...args,
            ]);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const blocked = await target.do(`${name} recovery fence ${generation}`, () =>
              catalogueMutationFenced(catalogueStore(env.CATALOGUE_DB)),
            );
            if (!blocked && !/catalogue_recovery_writer_fenced|recovery_not_verified/.test(detail)) throw error;
            if (!/fenced|recovery|blocked/.test(detail)) throw error;
            for (let wait = 0; ; wait++) {
              await target.sleep(`${name} recovery wait ${generation}:${wait}`, "5 seconds");
              const fenced = await target.do(`${name} recovery check ${generation}:${wait}`, () =>
                catalogueMutationFenced(catalogueStore(env.CATALOGUE_DB)),
              );
              if (!fenced) break;
            }
          }
        }
      };
    },
  });
}
