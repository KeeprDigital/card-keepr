import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { limitlessOnePieceSourceAdapterRegistration as adapter } from "../../src/catalogue/adapters/limitless-one-piece-source-adapter";
import type { SourceAdapterParent } from "../../src/catalogue/adapters/source-adapter-registration-types";

const pack = new URL("../../acceptance/fixtures/real-sources/2026-09-15-limitless/raw/", import.meta.url);

test("Limitless retains the same-name Leader's own design and Life without inventing a Cost", async () => {
  const observations = await adapter.parseBytes!(readFileSync(new URL("limitless-st01-001.body", pack)), {
    url: "https://onepiece.limitlesstcg.com/cards/ST01-001",
    mediaType: "text/html",
  });
  expect(observations).toEqual([
    expect.objectContaining({
      card: expect.objectContaining({
        official_identity: { kind: "card_number", value: "ST01-001" },
        name: "Monkey.D.Luffy",
        game_data: {
          profile: "one-piece@1",
          attributes: {
            card_type: "leader",
            colours: ["red"],
            cost: null,
            life: 5,
            battle_attributes: ["strike"],
            power: 5000,
            counter: null,
            traits: ["Straw Hat Crew", "Supernovas"],
            block_icons: ["1"],
            effect_text:
              "[Activate: Main] [Once Per Turn] Give this Leader or 1 of your Characters up to 1 rested DON!! card.",
            trigger_text: null,
          },
        },
      }),
    }),
  ]);
});

test("Limitless retains the Character's Counter independently of its Cost and Power", async () => {
  const observations = await adapter.parseBytes!(readFileSync(new URL("limitless-op16-002.body", pack)), {
    url: "https://onepiece.limitlesstcg.com/cards/OP16-002",
    mediaType: "text/html",
  });
  expect(observations).toEqual([
    expect.objectContaining({
      card: expect.objectContaining({
        official_identity: { kind: "card_number", value: "OP16-002" },
        game_data: expect.objectContaining({
          attributes: expect.objectContaining({ card_type: "character", cost: 1, power: 2000, counter: 1000 }),
        }),
      }),
    }),
  ]);
});

test("Limitless separates an Event Trigger from its effect and preserves non-applicable combat properties", async () => {
  const observations = await adapter.parseBytes!(readFileSync(new URL("limitless-op16-019.body", pack)), {
    url: "https://onepiece.limitlesstcg.com/cards/OP16-019",
    mediaType: "text/html",
  });
  expect(observations).toEqual([
    expect.objectContaining({
      card: expect.objectContaining({
        game_data: expect.objectContaining({
          attributes: expect.objectContaining({
            card_type: "event",
            cost: 9,
            power: null,
            battle_attributes: [],
            counter: null,
            effect_text:
              '[Main] Play up to 2 Character cards with a type including "Whitebeard Pirates" and 8000 power from your hand.',
            trigger_text: "[Trigger] Your Leader gains +1000 power during this turn.",
          }),
        }),
      }),
    }),
  ]);
});

test("Limitless discovers the Stage's complete variant inventory and its exact front", async () => {
  const bytes = readFileSync(new URL("limitless-op16-021.body", pack));
  const context = { url: "https://onepiece.limitlesstcg.com/cards/OP16-021", mediaType: "text/html" };
  expect(await adapter.parseBytes!(bytes, context)).toEqual([
    expect.objectContaining({
      card: expect.objectContaining({
        game_data: expect.objectContaining({
          attributes: expect.objectContaining({
            card_type: "stage",
            cost: 1,
            power: null,
            battle_attributes: [],
            trigger_text: null,
            effect_text:
              "[On Play] If your Leader has the {Whitebeard Pirates} type, look at 3 cards from the top of your deck and add up to 1 card to your hand. Then, place the rest at the bottom of your deck in any order.\n[Activate: Main] You may trash this Stage: Give up to 1 rested DON!! card to your Leader or 1 of your Characters.",
          }),
        }),
      }),
    }),
  ]);
  expect(adapter.discoverRequests!(bytes, context)).toEqual([
    {
      role: "detail",
      url: "https://onepiece.limitlesstcg.com/cards/OP16-021?v=1",
      headers: { accept: "text/html" },
    },
    {
      role: "image",
      url: "https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/OP16/OP16-021_EN.webp",
      headers: { accept: "image/webp" },
    },
  ]);
});

test("the named Limitless pilot declares all five complete Card inventories while preserving the P-001 root", () => {
  const coverage = adapter.coverageContracts!["five-card-pilot"]!;
  expect(coverage.cardIdentities).toEqual([
    { kind: "card_number", value: "P-001" },
    { kind: "card_number", value: "ST01-001" },
    { kind: "card_number", value: "OP16-002" },
    { kind: "card_number", value: "OP16-019" },
    { kind: "card_number", value: "OP16-021" },
  ]);
  expect(coverage.requiredSurfaces.map(coverage.requestUrlForSurface)).toEqual([
    "https://onepiece.limitlesstcg.com/cards/en/P-001",
    "https://onepiece.limitlesstcg.com/cards/ST01-001",
    "https://onepiece.limitlesstcg.com/cards/OP16-002",
    "https://onepiece.limitlesstcg.com/cards/OP16-019",
    "https://onepiece.limitlesstcg.com/cards/OP16-021",
  ]);
  expect(() => coverage.requestUrlForSurface("unselected-card")).toThrow("Unknown Limitless coverage surface");
});

test("an English URL alias preserves the already admitted P-001 source locator", async () => {
  const bytes = readFileSync(
    new URL("../../acceptance/fixtures/real-sources/2026-09-06/raw/limitless-p001.body", import.meta.url),
  );
  const observations = await adapter.parseBytes!(bytes, {
    url: "https://onepiece.limitlesstcg.com/cards/P-001",
    mediaType: "text/html",
  });
  expect(observations).toEqual([
    expect.objectContaining({
      identity_evidence: expect.objectContaining({ locator: "https://onepiece.limitlesstcg.com/cards/en/P-001" }),
    }),
  ]);
});

test("a sibling Printing table must agree with its exact retained parent inventory", async () => {
  const sibling = readFileSync(new URL("limitless-st01-001-v1.body", pack), "utf8");
  const context = {
    url: "https://onepiece.limitlesstcg.com/cards/ST01-001?v=1",
    mediaType: "text/html",
    parents: [
      {
        requestId: "limitless-one-piece-en:st01-001-catalogue",
        snapshotId: "retained-st01-base",
        role: "listing",
        url: "https://onepiece.limitlesstcg.com/cards/ST01-001",
        mediaType: "text/html",
        retrievedAt: "2026-09-15T20:36:00Z",
        contentSha256: "eb1b796dc5b493fd66085438cfe59084e9f71c32eacafb143c5d135c0cf577a7",
        bytes: readFileSync(new URL("limitless-st01-001.body", pack)),
      },
    ],
  };
  expect(await adapter.parseBytes!(new TextEncoder().encode(sibling), context)).toHaveLength(1);
  const changed = sibling.replace(
    /(<table class="card-prints-versions">[\s\S]*?)(<\/table>)/u,
    '$1<tr><td><a href="/cards/ST01-001?v=2">Another appearance</a></td></tr>$2',
  );
  await expect(
    Promise.resolve().then(() => adapter.parseBytes!(new TextEncoder().encode(changed), context)),
  ).rejects.toThrow("Limitless Printing inventory changed between retained pages");
});

test("the retained five-Card Limitless graph closes at fourteen pages and fourteen original fronts", async () => {
  type Capture = { url: string; body: string; sha256: string; contentType: string; startedAt: string };
  const captures = new Map(
    ["2026-09-06", "2026-09-15-limitless"].flatMap((directory) => {
      const root = new URL(`../../acceptance/fixtures/real-sources/${directory}/`, import.meta.url);
      const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8")) as { captures: Capture[] };
      return manifest.captures.map((capture) => [capture.url, { ...capture, root }] as const);
    }),
  );
  const coverage = adapter.coverageContracts!["five-card-pilot"]!;
  const queue: { url: string; role: string; parents: SourceAdapterParent[] }[] = coverage.requiredSurfaces.map(
    (surface) => ({ url: coverage.requestUrlForSurface(surface), role: "listing", parents: [] }),
  );
  const requested = new Set(queue.map((entry) => entry.url));
  let pages = 0;
  let fronts = 0;
  for (const request of queue) {
    const capture = captures.get(request.url);
    expect(capture, request.url).toBeDefined();
    const bytes = readFileSync(new URL(capture!.body, capture!.root));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture!.sha256);
    if (request.role === "image") {
      expect(capture!.contentType).toBe("image/webp");
      fronts++;
      continue;
    }
    const context = {
      url: request.url,
      requestId: `limitless-one-piece-en:${request.role}:${pages}`,
      mediaType: capture!.contentType,
      parents: request.parents,
    };
    expect(await adapter.parseBytes!(bytes, context)).toHaveLength(1);
    pages++;
    for (const child of adapter.discoverRequests!(bytes, context)) {
      if (requested.has(child.url)) continue;
      requested.add(child.url);
      queue.push({
        ...child,
        parents: [
          {
            requestId: context.requestId,
            snapshotId: `retained-page-${pages}`,
            role: request.role,
            url: request.url,
            mediaType: capture!.contentType,
            retrievedAt: capture!.startedAt,
            contentSha256: capture!.sha256,
            bytes,
          },
          ...request.parents,
        ],
      });
    }
  }
  expect({ pages, fronts, requests: requested.size }).toEqual({ pages: 14, fronts: 14, requests: 28 });
});
