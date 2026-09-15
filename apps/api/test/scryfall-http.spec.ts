import { expect, test } from "vitest";
import split from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/split-three.json";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { parseReconciliationObservation } from "../../../src/catalogue/reconciliation/reconciliation-observation";
import apiWorker from "../src/index";
import { apiCard, apiHeaders, installApiSuite, seedApiRevision, testEnv } from "./api-fixtures";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/read-openapi.json";

installApiSuite();

test("published split Card browsing and detail preserve unknown logical-face colours", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const [value] = await adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(split)), {
    url: split.uri,
    mediaType: "application/json",
  });
  const parsed = parseReconciliationObservation("retained-split", value);
  if (parsed.kind !== "card_printing" || !parsed.observedCardAndPrinting.card) throw new Error("Expected Card");
  const card = parsed.observedCardAndPrinting.card;
  await seedApiRevision({
    revisionId: "catrev_split_wire",
    runId: "run_split_wire",
    cards: [{ ...apiCard({ id: "card_split_wire", cardNumber: "", name: card.name }), ...card }],
  });
  for (const [path, definition] of [
    ["/v1/cards?game=magic", "/v1/cards"],
    ["/v1/cards/card_split_wire", "/v1/cards/{card}"],
  ] as const) {
    const response = await apiWorker.fetch(
      new Request(`https://card-keepr.invalid${path}`, { headers: apiHeaders("split-wire") }),
      testEnv,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const document = await response.json<{ data: unknown }>();
    const result = Array.isArray(document.data) ? document.data[0] : document.data;
    expect(result).toMatchObject({
      game_data: {
        attributes: {
          faces: [
            { name: "Smelt", colours: null },
            { name: "Herd", colours: null },
            { name: "Saw", colours: null },
          ],
        },
      },
    });
    await assertHttpResponse(contract, definition, "get", response, document);
  }
});
