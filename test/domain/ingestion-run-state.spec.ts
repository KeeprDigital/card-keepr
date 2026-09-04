import { describe, expect, test } from "vitest";
import {
  assertIngestionRunTransition,
  canTransitionIngestionRun,
  IngestionRunState,
  isTerminalIngestionRunState,
} from "../../src/catalogue/shared";

describe("Ingestion Run transitions", () => {
  test("collection can pause and resume without becoming terminal", () => {
    expect(() => assertIngestionRunTransition(IngestionRunState.Collecting, IngestionRunState.Paused)).not.toThrow();
    expect(() => assertIngestionRunTransition(IngestionRunState.Paused, IngestionRunState.Collecting)).not.toThrow();
    expect(isTerminalIngestionRunState(IngestionRunState.Paused)).toBe(false);
    expect(canTransitionIngestionRun(IngestionRunState.Paused, IngestionRunState.Parsing)).toBe(false);
  });
});

test("publication cannot skip review and terminal runs cannot restart", () => {
  expect(() => assertIngestionRunTransition("planning", "published")).toThrow("Illegal Ingestion Run transition");
  expect(() => assertIngestionRunTransition("published", "collecting")).toThrow("Illegal Ingestion Run transition");
  expect(isTerminalIngestionRunState("published")).toBe(true);
  expect(isTerminalIngestionRunState("failed")).toBe(true);
});

test("a paused run fails only with both the termination reason and its retained decision", () => {
  expect(canTransitionIngestionRun("paused", "failed")).toBe(false);
  expect(canTransitionIngestionRun("paused", "failed", { failureCode: "ingestion_run_terminated" })).toBe(false);
  expect(canTransitionIngestionRun("paused", "failed", { terminationRecorded: true })).toBe(false);
  expect(
    canTransitionIngestionRun("paused", "failed", {
      failureCode: "ingestion_run_terminated",
      terminationRecorded: true,
    }),
  ).toBe(true);
});

test("termination keeps its paused-only eligibility even though other phases may fail", () => {
  expect(() =>
    assertIngestionRunTransition("collecting", "failed", {
      requiredFrom: "paused",
      failureCode: "ingestion_run_terminated",
      terminationRecorded: true,
    }),
  ).toThrow("Illegal Ingestion Run transition");
});
