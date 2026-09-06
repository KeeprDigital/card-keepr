import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import ingestionWorker from "../src/index";
import { installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

// Synthetic fault injection at the database binding, through the real Worker
// HTTP handler. These are not retained real-source evidence fixtures.
test.each([
  [
    () => Object.assign(new Error("private-provider bearer-secret raw-source-body"), { code: "NoSuchKey" }),
    "missing_object",
  ],
  [() => new TypeError("private-provider bearer-secret raw-source-body"), "programming_fault"],
  [() => new Error("D1_ERROR: private-provider bearer-secret raw-source-body"), "sql_failure"],
])("administration failures retain protected %s classification", async (makeFailure, classification) => {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));
  vi.spyOn(console, "info").mockImplementation((value) => logs.push(String(value)));
  const failure = makeFailure();
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          throw failure;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const response = await ingestionWorker.fetch(
    new Request("https://card-keepr.invalid/v1/status?secret=query-secret", {
      headers: { authorization: "Bearer vitest-administration-key", "x-secret": "header-secret" },
    }),
    { ...env, CATALOGUE_DB: database },
  );
  expect(response.status).toBe(500);
  const problem = await response.json<{ request_id: string }>();
  expect(problem).toEqual({
    type: "https://card-keepr.invalid/problems/internal_error",
    title: "Internal server error",
    status: 500,
    code: "internal_error",
    detail: "The administration request could not be completed.",
    request_id: expect.any(String),
  });
  const events = logs.map((line) => JSON.parse(line));
  expect(events.find((event) => event.event === "request.failed")).toMatchObject({
    runtime: "ingestion",
    request_id: problem.request_id,
    cause_chain_truncated: false,
    causes: [{ classification, stack_reference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }],
  });
  expect(events.find((event) => event.event === "request.completed").request.id).toBe(problem.request_id);
  for (const secret of [
    "private-provider",
    "bearer-secret",
    "raw-source-body",
    "query-secret",
    "header-secret",
    "vitest-administration-key",
  ])
    expect(JSON.stringify([logs, problem])).not.toContain(secret);
});
