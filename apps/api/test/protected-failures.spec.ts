import { expect, test, vi } from "vitest";
import apiWorker from "../src/index";
import { installApiSuite, testEnv } from "./api-fixtures";

installApiSuite();

test("injected SQL failure preserves protected cause correlation through authenticated HTTP", async () => {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));
  vi.spyOn(console, "info").mockImplementation((value) => logs.push(String(value)));
  const cause = new Error("D1_ERROR: SELECT bearer-secret FROM private-provider; raw-source-body");
  const failure = new Error("request-body", { cause });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          throw failure;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    { ...testEnv, CATALOGUE_DB: database },
  );
  expect(response.status).toBe(500);
  const problem = await response.json<{ request_id: string }>();
  expect(problem).toEqual({
    type: "https://card-keepr.invalid/problems/internal_error",
    title: "Internal server error",
    status: 500,
    code: "internal_error",
    detail: "The request could not be completed.",
    request_id: expect.any(String),
  });
  const event = logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "request.failed");
  expect(event).toMatchObject({
    runtime: "api",
    request_id: problem.request_id,
    causes: [
      { classification: "unexpected_error", stack_reference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      { classification: "sql_failure", stack_reference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    ],
  });
  for (const secret of ["bearer-secret", "private-provider", "raw-source-body", "request-body", "vitest-api-key"])
    expect(JSON.stringify([logs, problem])).not.toContain(secret);
});

test("injected cyclic and oversized causes remain bounded and omit arbitrary error properties", async () => {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));
  const failure = new TypeError("raw-source-payload".repeat(10000));
  failure.stack =
    "Bearer vitest-api-key\n" +
    "    at sensitive-provider (https://private-provider/credential-secret:12:34)\n".repeat(10000);
  Object.assign(failure, {
    cause: failure,
    body: "request-body-secret",
    headers: { authorization: "Bearer bearer-secret" },
  });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          throw failure;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    { ...testEnv, CATALOGUE_DB: database },
  );
  expect(response.status).toBe(500);
  const event = JSON.parse(logs[0]!);
  expect(event.causes).toEqual([
    { classification: "programming_fault", stack_reference: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
  ]);
  expect(event.cause_chain_truncated).toBe(true);
  expect(logs[0]!.length).toBeLessThan(2048);
  const body = await response.text();
  for (const secret of [
    "raw-source-payload",
    "vitest-api-key",
    "private-provider",
    "credential-secret",
    "request-body-secret",
    "bearer-secret",
  ])
    expect(logs.join("\n") + body).not.toContain(secret);
});

test("an injected undefined throw still retains an unexpected failure classification", async () => {
  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((value) => logs.push(String(value)));
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property, receiver) {
      if (property === "prepare")
        return () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Prove arbitrary thrown values are sanitized.
          throw undefined;
        };
      return Reflect.get(target, property, receiver);
    },
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/catalogue", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
    { ...testEnv, CATALOGUE_DB: database },
  );
  expect(response.status).toBe(500);
  expect(JSON.parse(logs[0]!).causes).toEqual([{ classification: "unexpected_error", stack_reference: null }]);
});
