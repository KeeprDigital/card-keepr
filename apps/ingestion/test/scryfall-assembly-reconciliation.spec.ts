import { expect, test } from "vitest";
import bloomvine from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json?raw";
import control from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import split from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/split-three.json?raw";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { get, installReconciliationSuite, postFixtureEvidence, testEnv } from "./reconciliation-helpers";
import { prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  pendingEvidenceRequests,
  requiredEvidenceRun,
} from "../../../src/catalogue/source-evidence";

installReconciliationSuite({ directPreparation: true });

test("review-required source claims retain separate finish proposals while the resolved control reaches the candidate", async () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const values: unknown[] = [];
  for (const raw of [bloomvine, control, split])
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
  const reviews = proposals.filter((p) => JSON.parse(p.reference)[0] === JSON.parse(bloomvine).id);
  expect(reviews.map((p) => JSON.parse(p.reference)[1]).sort()).toEqual(["foil", "nonfoil"]);
  for (const proposal of reviews) {
    const inspected = (await get(`/v1/entity-proposals/${proposal.id}`)).document;
    expect(inspected).toMatchObject({
      status: "unresolved",
      generation: 0,
      content: { finish: JSON.parse(proposal.reference)[1] },
    });
    expect(inspected.content).not.toHaveProperty("card");
    expect(inspected.content).not.toHaveProperty("printing");
    expect(
      new TextEncoder().encode(JSON.stringify({ content: inspected.content, evidence: inspected.evidence })).byteLength,
    ).toBeLessThan(65536);
  }
});
