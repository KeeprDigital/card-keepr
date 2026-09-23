import { expect, test } from "vitest";
import bloomvine from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json?raw";
import reminder from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/manifest-reminder.json?raw";
import control from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import split from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/split-three.json?raw";
import gameplayPiece from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/token-layout-gameplay.json?raw";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import {
  exportComponentRecords,
  get,
  installReconciliationSuite,
  postFixtureEvidence,
  testEnv,
} from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { catalogueStore, scryfallSourceImageLinks } from "../../../src/catalogue/shared";
import { compositionEntityResponse } from "../../../src/catalogue/read/composition-read";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";

installReconciliationSuite({ directPreparation: true });

test("review-required source claims retain separate finish proposals while the resolved control reaches the candidate", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const values: unknown[] = [];
  for (const raw of [bloomvine, reminder, control, split])
    values.push(
      ...(await adapter.parseBytes!(new TextEncoder().encode(raw), {
        url: JSON.parse(raw).uri,
        mediaType: "application/json",
      })),
    );
  const started = await postFixtureEvidence({
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: "fixture-magic-json@1",
    idempotency_key: "assembly-review-control",
    requests: [{ id: "cards", url: "https://official-source.invalid/assembly-review-control" }],
  });
  expect(started.response.status).toBe(201);
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const run = await requiredEvidenceRun(db, String(started.document.id));
  const [root] = await pendingEvidenceRequests(db, run.id);
  const imageUrls = [
    ...new Set(
      values.flatMap((value) =>
        (value as { appearance_evidence: { images: { source_url: string }[] } }).appearance_evidence.images.map(
          (image) => image.source_url,
        ),
      ),
    ),
  ];
  await appendDiscoveredEvidenceRequests(
    db,
    run,
    root!,
    imageUrls.map((url) => ({ role: "image", url, headers: { accept: "image/png" } })),
  );
  // The fixture transport carries real adapter output through production D1/R2
  // and reconciliation. Image bytes are a synthetic transport fixture, not scans.
  const image = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
    (c) => c.charCodeAt(0),
  );
  const transport = {
    async fetch(input: RequestInfo | URL) {
      const url = new Request(input).url;
      return url.startsWith("https://cards.scryfall.io/")
        ? new Response(image, { headers: { "content-type": "image/png" } })
        : Response.json({ cards: values });
    },
  } as Fetcher;
  const runId = String(started.document.id);
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, runId);
  const candidate = await prepareNativeEvidence({
    runId,
    game: "magic",
    predecessor: "catrev_spine_000",
    key: "assembly-review-candidate",
  });
  const records = await nativeCandidateRecords(String(candidate.id), ["cards", "printings"]);
  expect(records.cards).toHaveLength(2);
  expect(records.cards!.map(({ name }) => name).sort()).toEqual(["Miara, Thorn of the Glade", "Smelt // Herd // Saw"]);
  expect(records.cards!.find(({ name }) => name === "Smelt // Herd // Saw")).toMatchObject({
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
  expect(records.printings).toHaveLength(2);
  const proposals = (await get("/v1/entity-proposals?game=magic")).document.proposals as {
    id: string;
    reference: string;
  }[];
  for (const [raw, reason] of [
    [bloomvine, "logical_parts_unresolved"],
    [reminder, "category_unresolved"],
  ] as const) {
    const reviews = proposals.filter((p) => JSON.parse(p.reference)[0] === JSON.parse(raw).id);
    expect(reviews.map((p) => JSON.parse(p.reference)[1]).sort()).toEqual(["foil", "nonfoil"]);
    for (const proposal of reviews) {
      const inspected = (await get(`/v1/entity-proposals/${proposal.id}`)).document;
      expect(inspected).toMatchObject({
        status: "unresolved",
        generation: 0,
        content: { finish: JSON.parse(proposal.reference)[1] },
        evidence: { issues: [{ code: reason }] },
      });
      expect(inspected.content).not.toHaveProperty("card");
      expect(inspected.content).not.toHaveProperty("printing");
      expect(inspected.content).not.toHaveProperty("category");
      expect(
        new TextEncoder().encode(JSON.stringify({ content: inspected.content, evidence: inspected.evidence }))
          .byteLength,
      ).toBeLessThan(65536);
    }
  }
});

test("a facts-only run admits qualified Printings without image bytes and keeps each image gap explicit", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const values: unknown[] = [];
  for (const raw of [control, gameplayPiece, bloomvine])
    values.push(
      ...(await adapter.parseBytes!(new TextEncoder().encode(raw), {
        url: JSON.parse(raw).uri,
        mediaType: "application/json",
      })),
    );
  const started = await postFixtureEvidence({
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: "fixture-scryfall-source-record@1",
    idempotency_key: "facts-only-source-record",
    requests: [{ id: "cards", url: "https://official-source.invalid/facts-only-source-record" }],
  });
  expect(started.response.status).toBe(201);
  const requested: string[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL) {
      requested.push(new Request(input).url);
      return Response.json({ cards: values });
    },
  } as Fetcher;
  const runId = String(started.document.id);
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, runId);
  // No image request exists: every Printing below rests on its qualified source record.
  expect(requested).toEqual(["https://official-source.invalid/facts-only-source-record"]);
  const candidate = await prepareNativeEvidence({
    runId,
    game: "magic",
    predecessor: "catrev_spine_000",
    key: "facts-only-source-record-candidate",
  });
  const inspected = await get(`/v1/game-candidates/${candidate.id}/inspection?manifest=${candidate.manifest_digest}`);
  expect(inspected.document).toMatchObject({ ready: true });
  const records = await nativeCandidateRecords(String(candidate.id), ["cards", "printings", "printing_images"]);
  expect(
    records
      .cards!.map(({ name, category }) => ({ name: String(name), category }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ).toEqual([
    { name: "Maddened Oread", category: "gameplay" },
    { name: "Miara, Thorn of the Glade", category: "gameplay" },
  ]);
  const finishes = [control, gameplayPiece].flatMap((raw) => JSON.parse(raw).finishes as string[]);
  expect(records.printings).toHaveLength(finishes.length);
  expect(records.printing_images ?? []).toEqual([]);
  const proposals = (await get("/v1/entity-proposals?game=magic")).document.proposals as {
    id: string;
    reference: string;
    status: string;
  }[];
  // The incomplete reversible design stays an unresolved, non-blocking proposal per finish.
  expect(
    proposals
      .filter((proposal) => JSON.parse(proposal.reference)[0] === JSON.parse(bloomvine).id)
      .map(({ status }) => status),
  ).toEqual(["unresolved", "unresolved"]);
});

const consumerBase = { origin: "https://catalogue.example", basePath: "" };
type PublishedPrinting = {
  id: string;
  game_data: { attributes: { collector_number: string } };
  printing_images: unknown[];
  source_image?: Record<string, unknown>;
};
const png = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
  (c) => c.charCodeAt(0),
);
const frontImageUrl = (raw: string) => String(JSON.parse(raw).image_uris.normal);

/** Collect and prepare exact Scryfall records; only the listed image URLs are acquired. */
async function prepareScryfallRecords(input: {
  adapterVersion: string;
  key: string;
  raws: readonly string[];
  imageUrls: readonly string[];
  predecessor: string;
}) {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const values: unknown[] = [];
  for (const raw of input.raws)
    values.push(
      ...(await adapter.parseBytes!(new TextEncoder().encode(raw), {
        url: JSON.parse(raw).uri,
        mediaType: "application/json",
      })),
    );
  const started = await postFixtureEvidence({
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: input.adapterVersion,
    idempotency_key: input.key,
    requests: [{ id: "cards", url: `https://official-source.invalid/${input.key}` }],
  });
  expect(started.response.status).toBe(201);
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const run = await requiredEvidenceRun(db, String(started.document.id));
  if (input.imageUrls.length) {
    const [root] = await pendingEvidenceRequests(db, run.id);
    await appendDiscoveredEvidenceRequests(
      db,
      run,
      root!,
      input.imageUrls.map((url) => ({ role: "image", url, headers: { accept: "image/png" } })),
    );
  }
  const requested: string[] = [];
  const transport = {
    async fetch(request: RequestInfo | URL) {
      const url = new Request(request).url;
      requested.push(url);
      return url.startsWith("https://cards.scryfall.io/")
        ? new Response(png, { headers: { "content-type": "image/png" } })
        : Response.json({ cards: values });
    },
  } as Fetcher;
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, run.id);
  // A Source Image Link is never fetched: only the planned requests were sent.
  expect(requested.sort()).toEqual([`https://official-source.invalid/${input.key}`, ...input.imageUrls].sort());
  return prepareNativeEvidence({
    runId: run.id,
    game: "magic",
    predecessor: input.predecessor,
    key: `${input.key}-candidate`,
  });
}

async function publishedPrintings() {
  const list = (await (await compositionEntityResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/printings?game=magic`),
    consumerBase,
    "printings",
  ))!.json()) as { data: PublishedPrinting[] };
  const byNumber = new Map<string, PublishedPrinting>();
  for (const printing of list.data) {
    const detail = (await (await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${consumerBase.origin}/v1/printings/${printing.id}`),
      consumerBase,
      "printings",
      printing.id,
    ))!.json()) as { data: PublishedPrinting };
    expect(detail.data.source_image).toEqual(printing.source_image);
    byNumber.set(printing.game_data.attributes.collector_number, detail.data);
  }
  return byNumber;
}

test("an opted-in Printing without a retained image serves its claimed URL as an unverified link that a refresh replaces", async () => {
  const withImage = JSON.parse(control).collector_number as string;
  const imageless = JSON.parse(gameplayPiece).collector_number as string;
  const first = await prepareScryfallRecords({
    adapterVersion: "fixture-scryfall-source-record@1",
    key: "source-image-link-first",
    raws: [control, gameplayPiece],
    imageUrls: [frontImageUrl(control)],
    predecessor: "catrev_spine_000",
  });
  const published = await approveNativeCandidate(first, "source-image-link-first-publish");
  const revision = String(published.document.resulting_revision_id);
  const expectedLink = (url: string) => ({
    url,
    role: "front",
    source: "scryfall",
    retrieved_at: expect.any(String),
    verified: false,
    attribution: { ...scryfallSourceImageLinks.attribution },
  });
  let printings = await publishedPrintings();
  expect(printings.get(withImage)!.printing_images).toHaveLength(1);
  expect(printings.get(withImage)).not.toHaveProperty("source_image");
  expect(printings.get(imageless)!.printing_images).toEqual([]);
  expect(printings.get(imageless)!.source_image).toEqual(expectedLink(frontImageUrl(gameplayPiece)));
  // Exports carry accepted Catalogue Data only, never the unverified link.
  const exported = await exportComponentRecords(revision, "printings");
  expect(exported).toHaveLength(2);
  for (const record of exported) {
    expect(record).not.toHaveProperty("source_image");
    expect(record).not.toHaveProperty("source_image_link");
  }

  // Scryfall's cache-busting timestamp changes; the refreshed record's exact URL replaces the stale one.
  const refreshedUrl = frontImageUrl(gameplayPiece).replace(/\?\d+$/u, "?1799999999");
  const refreshed = JSON.parse(gameplayPiece);
  refreshed.image_uris.normal = refreshedUrl;
  const second = await prepareScryfallRecords({
    adapterVersion: "fixture-scryfall-source-record@1",
    key: "source-image-link-refresh",
    raws: [control, JSON.stringify(refreshed)],
    imageUrls: [],
    predecessor: revision,
  });
  await approveNativeCandidate(second, "source-image-link-refresh-publish");
  printings = await publishedPrintings();
  // The carried Printing Image still suppresses the link although this run acquired no image.
  expect(printings.get(withImage)!.printing_images).toHaveLength(1);
  expect(printings.get(withImage)).not.toHaveProperty("source_image");
  expect(printings.get(imageless)!.source_image).toEqual(expectedLink(refreshedUrl));
});

test("a registration without the Source Image Link opt-in never records a link", async () => {
  const candidate = await prepareScryfallRecords({
    adapterVersion: "fixture-scryfall-source-record-unlinked@1",
    key: "source-image-link-unlinked",
    raws: [control, gameplayPiece],
    imageUrls: [],
    predecessor: "catrev_spine_000",
  });
  const records = await nativeCandidateRecords(String(candidate.id), ["printings", "printing_images"]);
  expect(records.printings).toHaveLength(2);
  expect(records.printing_images ?? []).toEqual([]);
  for (const printing of records.printings!) expect(printing).not.toHaveProperty("source_image_link");
});
