import { expect, test } from "vitest";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

test("new publisher authority remains opt-in and an explicit owner designation is visible", async () => {
  const before = await (await administrationRequest("/v1/source-authorities", "GET")).json<{
    authorities: { game: string }[];
  }>();
  expect(before.authorities.some((a) => a.game === "riftbound")).toBe(false);
  const selection = {
    game: "riftbound",
    locale: "en",
    release_region: "US",
    area: "corrected_card_content",
    source_lineage: "riftbound-en",
    expected_generation: "0",
    rationale: "Use retained Riot corrections for the English scope.",
    idempotency_key: "riftbound-corrections-authority",
  };
  const changed = await administrationRequest("/v1/source-authorities", "POST", selection);
  expect(changed.status).toBe(200);
  const decision = await changed.json();
  const after = await (await administrationRequest("/v1/source-authorities", "GET")).json<{ authorities: unknown[] }>();
  expect(after.authorities).toContainEqual(decision);
  expect(after.authorities).toHaveLength(before.authorities.length + 1);
  expect(await (await administrationRequest("/v1/source-authorities", "POST", selection)).json()).toEqual(decision);
  expect(
    (
      await administrationRequest("/v1/source-authorities", "POST", {
        ...selection,
        idempotency_key: "riftbound-stale-authority",
      })
    ).status,
  ).toBe(409);
});

test("owner inspects source ownership and shared profiles independently of authority", async () => {
  const response = await administrationRequest("/v1/source-registry", "GET");
  expect(response.status).toBe(200);
  const registry = await response.json<Record<string, unknown>>();
  expect(registry.publishers).toContainEqual({ id: "bandai", name: "Bandai" });
  expect(registry.sources).toContainEqual(
    expect.objectContaining({
      id: "limitless-one-piece",
      publisher_id: null,
    }),
  );
  expect(registry.lineages).toContainEqual(
    expect.objectContaining({
      id: "one-piece-en",
      source_id: "bandai-one-piece",
      game: "one-piece",
      locale: "en",
      release_region: "OCEANIA",
    }),
  );
  expect(registry.profiles).toContainEqual(expect.objectContaining({ id: "one-piece@1", game: "one-piece" }));
});

test("owner explicitly changes scoped authority with replay, stale-write rejection and no ownership takeover", async () => {
  const before = await administrationRequest("/v1/source-authorities", "GET");
  expect(before.status).toBe(200);
  expect(await before.json()).toMatchObject({
    authorities: expect.arrayContaining([
      expect.objectContaining({ game: "one-piece", area: "card_facts", source_lineage: "one-piece-en", generation: 0 }),
    ]),
  });
  const selection = {
    game: "one-piece",
    locale: "en",
    release_region: "OCEANIA",
    area: "card_facts",
    source_lineage: "limitless-one-piece-en",
    expected_generation: "0",
    rationale: "Selected supplemental card facts",
    idempotency_key: "select-limitless",
  };
  const changed = await administrationRequest("/v1/source-authorities", "POST", selection);
  expect(changed.status).toBe(200);
  const decision = await changed.json();
  expect(decision).toMatchObject({ source_lineage: "limitless-one-piece-en", generation: 1 });
  expect(await (await administrationRequest("/v1/source-authorities", "POST", selection)).json()).toEqual(decision);
  expect(
    (
      await administrationRequest("/v1/source-authorities", "POST", {
        ...selection,
        idempotency_key: "stale",
        source_lineage: "one-piece-en",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await administrationRequest("/v1/source-authorities", "POST", {
        ...selection,
        expected_generation: "1",
        idempotency_key: "wrong-game",
        source_lineage: "digimon-en",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await administrationRequest("/v1/source-authorities", "POST", {
        ...selection,
        expected_generation: "1",
        idempotency_key: "wrong-locale",
        locale: "ja",
      })
    ).status,
  ).toBe(422);
  const after = await (await administrationRequest("/v1/source-authorities", "GET")).json();
  expect(after).toMatchObject({
    authorities: expect.arrayContaining([
      expect.objectContaining({
        game: "one-piece",
        area: "card_facts",
        source_lineage: "limitless-one-piece-en",
        generation: 1,
      }),
      expect.objectContaining({
        game: "one-piece",
        area: "printing_details",
        source_lineage: "one-piece-en",
        generation: 0,
      }),
    ]),
  });
});

test("an in-flight collection fences authority changes", async () => {
  const collected = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: "authority-fence-run",
    requests: [{ id: "one-piece-en:discovery", url: "https://cards.example.invalid/facts" }],
  });
  expect(collected.status).toBe(201);
  const changed = await administrationRequest("/v1/source-authorities", "POST", {
    game: "one-piece",
    locale: "en",
    release_region: "OCEANIA",
    area: "printing_details",
    source_lineage: "limitless-one-piece-en",
    expected_generation: "0",
    rationale: "Must wait for collection",
    idempotency_key: "busy-authority",
  });
  expect(changed.status).toBe(409);
});
