import { expect, test } from "vitest";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

const bounded = {
  supported_game: "one-piece",
  source_lineage: "one-piece-en",
  adapter_version: "one-piece-en@6",
  subset: "p-001-catalogue",
  requests: [{ id: "one-piece-en:p-001-catalogue", url: "https://en.onepiece-cardgame.com/cardlist/?freewords=P-001" }],
};

test("owner pins independently complete P-001 coverage without claiming full Bandai discovery", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...bounded,
    idempotency_key: "bounded-p001",
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ evidence_plans: [{ coverage: { subset: "p-001-catalogue" } }] });
  const changed = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...bounded,
    subset: "complete",
    idempotency_key: "bounded-p001",
  });
  expect(changed.status).toBe(422);
});

test("owner can select concrete Limitless P-001 coverage bound to the same One Piece profile", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "limitless-one-piece-en",
    adapter_version: "limitless-one-piece-en@1",
    subset: "p-001-catalogue",
    idempotency_key: "limitless-p001",
    requests: [
      { id: "limitless-one-piece-en:p-001-catalogue", url: "https://onepiece.limitlesstcg.com/cards/en/P-001" },
    ],
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    evidence_plans: [{ game_profile_version: "one-piece@1", coverage: { subset: "p-001-catalogue" } }],
  });
});

test("owner separately declares the catalogue search and retained event corroboration", async () => {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    ...bounded,
    subset: "p-001-catalogue-and-corroboration",
    idempotency_key: "p001-corroboration",
    requests: [
      ...bounded.requests,
      {
        id: "one-piece-en:store-championship-p001",
        url: "https://en.onepiece-cardgame.com/events/2023/championship/store_championship_wave1.php",
      },
    ],
  });
  expect(response.status).toBe(201);
});
