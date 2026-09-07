import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";
import { verifyExportManifest, verifyExportRecord } from "../../src/catalogue/export/export-validation";

const games = ["one-piece", "fusion-world", "digimon", "gundam", "riftbound"];
const supportedGame = (game: string) => ({
  type: "supported_game",
  id: `game_${game}`,
  key: game,
  name: game,
  supported_locales: ["EN-US"],
  game_profile: `${game}@1`,
});

test.each(games)("active export contract accepts the supported game %s", (game) => {
  expect(() => verifyExportRecord(supportedGame(game))).not.toThrow();
  expect(() => verifyExportRecord(supportedGame("unregistered"))).toThrow();
});

test("active export accepts Riftbound publisher-name identity and profile without accepting unknown variants", () => {
  const card = {
    type: "card",
    id: "card_monk",
    game: "riftbound",
    name: "Kinkou Monk",
    official_identity: { kind: "publisher_name", value: "Kinkou Monk" },
    effective_rules_text: null,
    game_data: { profile: "riftbound@1", attributes: {} },
    lifecycle: { first_revision_id: "catrev_1", last_observed_revision_id: "catrev_1", withdrawn: false },
  };
  expect(() => verifyExportRecord(card)).not.toThrow();
  for (const identity of [
    { kind: "publisher_name", value: "" },
    { kind: "invented", value: "Monk" },
  ])
    expect(() => verifyExportRecord({ ...card, official_identity: identity })).toThrow();
  for (const profile of ["unregistered@1", "riftbound@0"])
    expect(() => verifyExportRecord({ ...card, game_data: { ...card.game_data, profile } })).toThrow();
});

test("active manifest accepts Riftbound components and five-game membership while retaining page and name constraints", () => {
  const component = {
    name: "riftbound.0",
    kind: "supported-games",
    media_type: "application/x-ndjson",
    compression: "gzip",
    record_schema: "https://card-keepr.invalid/schemas/catalogue-export-record@5#/$defs/SupportedGameRecord",
    records: 1,
    uncompressed_bytes: 200,
    content_sha256: "a".repeat(64),
    compressed_bytes: 100,
    compressed_sha256: "b".repeat(64),
  };
  const manifest = {
    format: "card-keepr-catalogue-export-manifest@5",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 5,
    catalogue_revision: { id: "catrev_1", content_sha256: "c".repeat(64) },
    published_at: "2026-09-08T00:00:00.000Z",
    export_created_at: "2026-09-08T00:00:00.000Z",
    supported_games: games,
    components: [component],
    page: { next_cursor: null },
    manifest_sha256: "d".repeat(64),
  };
  expect(() => verifyExportManifest(manifest)).not.toThrow();
  for (const name of ["unregistered.0", "riftbound.01", "riftbound.-1"])
    expect(() => verifyExportManifest({ ...manifest, components: [{ ...component, name }] })).toThrow();
  expect(() =>
    verifyExportManifest({
      ...manifest,
      components: Array.from({ length: 5 }, (_, i) => ({ ...component, name: `riftbound.${i}` })),
    }),
  ).toThrow();
});

test("active API and administration schema definitions include Riftbound but stay closed", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  for (const file of ["api.schema.json", "administration.schema.json"]) {
    const schema = JSON.parse(readFileSync(`prototype/formalize-implementation-contracts/schemas/${file}`, "utf8"));
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/SupportedGame`)!;
    for (const game of games) expect(validate(game)).toBe(true);
    expect(validate("unregistered")).toBe(false);
    if (file === "api.schema.json") {
      expect(
        ajv.getSchema(`${schema.$id}#/$defs/OfficialIdentity`)!({ kind: "publisher_name", value: "Kinkou Monk" }),
      ).toBe(true);
      expect(ajv.getSchema(`${schema.$id}#/$defs/GameData`)!({ profile: "riftbound@1", attributes: {} })).toBe(true);
      expect(ajv.getSchema(`${schema.$id}#/$defs/CardCollectionQuery`)!({ game: "riftbound" })).toBe(true);
    }
  }
});
