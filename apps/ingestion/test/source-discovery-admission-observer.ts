import type { CatalogueStore } from "../../../src/catalogue/shared";

export type AdmissionReadSample = { population: number; call: number; rowsRead: number; budget: number };
export type AdmissionPopulation = {
  population: number;
  native: D1Database;
  database: CatalogueStore;
  runId: string;
  parentId: string;
};

// The ignored bounded experiment can attach detailed receipts to this same
// test. Ordinary stress runs neither install diagnostics nor perform its reads.
export type AdmissionDiagnostics = {
  startPopulation(native: D1Database, population: number, binding: string): Promise<D1Database>;
  seeded(): void;
  setupComplete(details: Record<string, unknown>): Promise<void>;
  startCall(call: number): Promise<void>;
  finishCall(call: number, returned: boolean, error?: unknown): Promise<void>;
  finishPopulation(population: AdmissionPopulation): Promise<void>;
  complete(samples: AdmissionReadSample[]): Promise<void>;
  failure(error: unknown, population: AdmissionPopulation | null): Promise<void>;
};
let diagnosticFactory: (() => AdmissionDiagnostics) | undefined;
export function installAdmissionDiagnostics(factory: () => AdmissionDiagnostics): void {
  if (diagnosticFactory) throw new Error("Admission diagnostics already installed.");
  diagnosticFactory = factory;
}
export function admissionDiagnostics(): AdmissionDiagnostics | undefined {
  return diagnosticFactory?.();
}

// Count returned native batch metadata before CatalogueStore unwraps attached
// guard results. Forward the batch and its original results without alteration.
export function observeAdmissionBatchReads(native: D1Database) {
  let active = false;
  let rowsRead = 0;
  const binding = new Proxy(native, {
    get(target, property) {
      if (property === "batch")
        return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
          const results = await target.batch<T>(statements);
          if (active)
            for (const result of results) {
              const count = result.meta?.rows_read;
              if (typeof count !== "number" || !Number.isFinite(count) || count < 0)
                throw new Error("Native admission batch rows_read metadata is unavailable or invalid.");
              rowsRead += count;
            }
          return results;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    binding,
    start() {
      if (active) throw new Error("Admission read observation already active.");
      active = true;
      rowsRead = 0;
    },
    finish() {
      if (!active) throw new Error("Admission read observation was not started.");
      active = false;
      return rowsRead;
    },
  };
}
