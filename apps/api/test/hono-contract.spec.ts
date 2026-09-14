import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/read-openapi.json";

installApiSuite();

test("Card search and validation responses conform to the generated wire contract", async () => {
  await seedApiRevision({
    revisionId: "catrev_hono",
    runId: "run_hono",
    cards: [apiCard({ id: "card_hono", cardNumber: "OP01-001", name: "Captain" })],
  });
  for (const [query, expected] of [
    ["game=one-piece&q=Captain", 200],
    ["limit=01", 400],
    ["unknown=true", 400],
  ] as const) {
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid/v1/cards?${query}`, { headers: apiHeaders(`hono-${query}`) }),
      testEnv,
    );
    expect(response.status).toBe(expected);
    await assertHttpResponse(contract, "/v1/cards", "get", response);
  }
});

test("pilot methods preserve credential isolation and reject unsupported HEAD without reading catalogue data", async () => {
  for (const [method, key, status] of [
    ["GET", "vitest-administration-key", 401],
    ["HEAD", "vitest-api-key", 404],
    ["POST", "vitest-api-key", 404],
  ] as const) {
    const response = await apiWorker.fetch(
      new Request("https://card-keepr.invalid/v1/cards", { method, headers: { authorization: `Bearer ${key}` } }),
      testEnv,
    );
    expect(response.status).toBe(status);
    if (method === "GET") await assertHttpResponse(contract, "/v1/cards", "get", response);
  }
});

test("Card search preserves an owner-admitted unknown official identity", async () => {
  await seedApiRevision({
    revisionId: "catrev_unknown_identity",
    runId: "run_unknown_identity",
    cards: [
      {
        ...apiCard({ id: "card_unknown_identity", cardNumber: "", name: "Owner-admitted Card" }),
        official_identity: { kind: "unknown", value: null },
      },
    ],
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards", { headers: apiHeaders("unknown-identity") }),
    testEnv,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const document = await response.json<{ data: { official_identity: unknown }[] }>();
  expect(document.data[0]!.official_identity).toEqual({ kind: "unknown", value: null });
  await assertHttpResponse(contract, "/v1/cards", "get", response, document);
});

test.each([false, true])("Card search preserves the retained withdrawal marker %s", async (withdrawn) => {
  const revisionId = `catrev_withdrawal_${withdrawn}`;
  const withdrawal = { withdrawn, withdrawal: withdrawn ? { revision_id: revisionId } : null };
  await seedApiRevision({
    revisionId,
    runId: `run_withdrawal_${withdrawn}`,
    cards: [
      {
        ...apiCard({ id: `card_withdrawal_${withdrawn}`, cardNumber: "OP01-001", name: "Retained Card" }),
        lifecycle: {
          first_revision_id: revisionId,
          last_observed_revision_id: revisionId,
          ...withdrawal,
        },
      },
    ],
  });
  const response = await apiWorker.fetch(
    new Request("https://card-keepr.invalid/v1/cards", { headers: apiHeaders(`withdrawal-marker-${withdrawn}`) }),
    testEnv,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const document = await response.json<{ data: { lifecycle: unknown }[] }>();
  expect(document.data[0]!.lifecycle).toMatchObject(withdrawal);
  await assertHttpResponse(contract, "/v1/cards", "get", response, document);
});
