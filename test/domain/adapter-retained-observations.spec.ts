import { URL } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test, expect } from "vitest";
import { sourceAdapterRegistrations } from "../../src/catalogue/adapters/source-adapters";

const fixtureRoot = new URL("../../acceptance/fixtures/retained-official-source/", import.meta.url);
const baselinePath = new URL("./adapter-retained-observations.json", import.meta.url);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function fragmentUrl(filename: string, lineage: string): string {
  if (lineage === "digimon-en")
    return "https://world.digimoncard.com/cards/index.php?search=true&category=522037&cardcategory=Digimon&color=Blue";
  const locale = lineage === "gundam-en-asia" ? "asia-en" : "en";
  const base = `https://www.gundam-gcg.com/${locale}/cards/`;
  if (filename.includes("card-detail"))
    return `${base}detail.php?detailSearch=GD02-038${filename.includes("-p2-") ? "_p2" : ""}`;
  return `${base}index.php${filename.includes("-package-") ? `?package=${lineage === "gundam-en-asia" ? "619102" : "616102"}` : ""}`;
}

test("every retained fixture preserves its registered adapter observations and discovery", async () => {
  // Captured from 8e5cb5c before #109. Hash the serialized output itself;
  // canonicalizing it would hide an observable property-order change.
  const result: Record<string, unknown> = {};
  const full: Record<string, unknown> = {};
  const adapters = sourceAdapterRegistrations.filter(
    (adapter) => adapter.origin === "production" && adapter.reconciliationCapability === "catalogue",
  );
  for (const filename of readdirSync(fixtureRoot)
    .filter((name) => /\.(json|html)$/u.test(name))
    .sort()) {
    const adapter = adapters.find((adapter) => filename.startsWith(`${adapter.sourceLineage}-`))!;
    const metadata = filename.endsWith(".json")
      ? JSON.parse(readFileSync(new URL(filename, fixtureRoot), "utf8"))
      : null;
    const bytes =
      metadata === null ? readFileSync(new URL(filename, fixtureRoot)) : Buffer.from(metadata.body_base64, "base64");
    const url = metadata?.source_url ?? fragmentUrl(filename, adapter.sourceLineage);
    const mediaType = metadata?.content_type ?? "text/html; charset=UTF-8";
    const identities = [
      "discovery",
      ...(adapter.requiredSurfaces ?? []),
      ...["listing", "detail", "product_detail"].map((role) => `${role}:${"0".repeat(64)}`),
      ...["rules-hub", "news-hub", "policy-hub", "card-search"].map((stage) => `listing:${stage}:${"0".repeat(64)}`),
    ];
    const observations: Record<string, unknown> = {};
    for (const identity of identities) {
      const context = { url, mediaType, requestId: `${adapter.sourceLineage}:${identity}` };
      for (const [operation, parse] of [
        ["parse", adapter.parseBytes],
        ["discover", adapter.discoverRequests],
      ] as const) {
        try {
          observations[`${operation}:${identity}`] = { value: await parse!(bytes, context) };
        } catch (error) {
          observations[`${operation}:${identity}`] = { error: error instanceof Error ? error.message : String(error) };
        }
      }
    }
    full[filename] = observations;
    result[filename] = { bytes_sha256: digest(bytes), observations_sha256: digest(JSON.stringify(observations)) };
  }
  if (process.env.KEEPR_ADAPTER_OBSERVATIONS_PATH)
    writeFileSync(process.env.KEEPR_ADAPTER_OBSERVATIONS_PATH, JSON.stringify(full));
  expect(result).toEqual(JSON.parse(readFileSync(baselinePath, "utf8")));
});
