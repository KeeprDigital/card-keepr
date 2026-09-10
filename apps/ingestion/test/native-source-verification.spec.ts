import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { advanceAcceptedSource } from "../../../src/catalogue/reconciliation/unchanged-native-source";
import { ReconciliationDocumentStorageError } from "../../../src/catalogue/reconciliation/reconciliation-document";
import { collect, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { prepareNativeCandidate, seedNativePredecessor } from "./native-publication-helpers";

installReconciliationSuite();

test.each(["interrupted read", "missing selected request"])(
  "accepted source verification fails safely on %s",
  async (fault) => {
    const source = await collect("/reconciliation/base", "source-verification-contract");
    const first = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "source-verification-first");
    const prior = await seedNativePredecessor(first, "source-verification-predecessor");
    const successor = await prepareNativeCandidate(
      source.id,
      "one-piece",
      prior.revisionId,
      "source-verification-next",
    );
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    const args = [String(successor.id), "one-piece-en", "fixture-one-piece-json@3"] as const;
    const saved = await advanceAcceptedSource(db, ...args);
    expect(saved.stage).toBe("requests");
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
          if (
            property === "first" &&
            fault === "missing selected request" &&
            sql.includes("FROM reconciliation_evidence_selection")
          )
            return async () => null;
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    let intercepted = 0;
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (fault === "interrupted read" && sql.includes("SELECT snapshot.content_digest")) {
              intercepted++;
              throw new Error("Injected temporary D1 read outage.");
            }
            return wrap(target.prepare(sql), sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failed = advanceAcceptedSource(catalogueStore(database), ...args, structuredClone(saved));
    if (fault === "interrupted read") {
      await expect(failed).rejects.toBeInstanceOf(ReconciliationDocumentStorageError);
      expect(intercepted).toBe(1);
    } else await expect(failed).rejects.toThrow("missing retained evidence requests");
    // Resume the saved prefix against real storage; a failed attempt cannot advance it.
    let resumed = structuredClone(saved);
    for (let unit = 0; resumed.stage !== "complete" && unit < 8; unit++)
      resumed = await advanceAcceptedSource(db, ...args, resumed);
    expect(resumed).toMatchObject({ stage: "complete", unchanged: true, selected: 1 });
  },
);
