import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";

const adapter = requiredSourceAdapter("scryfall-magic-en@1");
const bytes = readFileSync(
  new URL("../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json", import.meta.url),
);
async function sourceEvidence() {
  const [value] = await adapter.parseBytes!(bytes, {
    url: JSON.parse(bytes.toString()).uri,
    mediaType: "application/json",
  });
  return parseSourceAdmissionEvidence(value, adapter);
}

test.each([
  ["mixed resolved Card", { card: { game: "magic" } }],
  ["different game", { game: "pokemon" }],
  ["different Source Lineage", { source_lineage: "tcgdex-pokemon-en" }],
  ["duplicate finishes", { declared_finishes: ["foil", "foil"] }],
  ["unrecognised finish", { declared_finishes: ["base"] }],
  ["unrecognised reason", { issues: [{ code: "parse_failed", source_paths: ["*"] }] }],
])("review intake rejects %s instead of manufacturing a partial admission", async (_name, patch) => {
  const awaited = await sourceEvidence();
  expect(() => parseSourceAdmissionEvidence({ ...awaited, ...patch }, adapter)).toThrow();
});
