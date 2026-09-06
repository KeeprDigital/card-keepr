import { expect, test } from "vitest";
import apiWorker from "../src/index";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";

installApiSuite();

test("authenticated consumers receive accepted card content without administrative evidence", async () => {
  // Synthetic accepted supplemental record; this is contract proof, not real-source admission evidence.
  const card = apiCard({ id: "card_content", cardNumber: "P-001", name: "Accepted supplemental card" });
  await seedApiRevision({ runId: "run_content", revisionId: "catrev_content", cards: [card] });
  const read = (path: string) =>
    apiWorker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        headers: apiHeaders("192.0.2.217"),
      }),
      testEnv,
    );
  const response = await read("/v1/cards/card_content");
  expect(response.status).toBe(200);
  const document = (await response.json()) as { data: Record<string, unknown> };
  expect(document.data).toMatchObject({ id: "card_content", effective_rules_text: "Accepted supplemental card" });
  expect(document.data).not.toHaveProperty("source_lineages");
  expect((await read("/v1/cards/card_content?include=evidence")).status).toBe(400);
  expect((await read("/v1/legality-status?card_id=card_content")).status).toBe(404);
});

test("published supplemental Cards appear by default and reject administrative filters", async () => {
  const card = apiCard({ id: "card_supplemental", cardNumber: "P-002", name: "Supplemental card" });
  card.source_lineages = ["synthetic-supplemental-source"];
  card.effective_rules_text = null;
  await seedApiRevision({ runId: "run_supplemental", revisionId: "catrev_supplemental", cards: [card] });
  const read = (path: string) =>
    apiWorker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        headers: apiHeaders("192.0.2.218"),
      }),
      testEnv,
    );
  const collection = await read("/v1/cards?q=Supplemental");
  expect(collection.status).toBe(200);
  expect(await collection.json()).toMatchObject({ data: [{ id: "card_supplemental" }] });
  const detail = await read("/v1/cards/card_supplemental");
  expect(await detail.json()).toMatchObject({ data: { effective_rules_text: null } });
  for (const parameter of ["provenance", "confidence", "confirmation", "source_health", "admission", "eligibility"]) {
    expect((await read(`/v1/cards?${parameter}=true`)).status).toBe(400);
    expect((await read(`/v1/cards/card_supplemental?${parameter}=true`)).status).toBe(400);
  }
});
