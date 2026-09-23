import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import firstPage from "../../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json?raw";
import secondPage from "../../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-200.json?raw";
import { catalogueStore } from "../../../src/catalogue/shared";
import { startEvidenceRun } from "../../../src/catalogue/source-evidence";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import { prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";

installReconciliationSuite({ directPreparation: true });

const inventory =
  "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200";

// Three unchanged Riot records, including a 1488x2078 overnumbered front, in
// a synthetic one-page envelope. The image bodies are synthetic: this proves
// the body bound, qualification and unchanged-image skipping of a full
// refresh, not real image coverage (#333).
function envelope() {
  const records = [JSON.parse(firstPage), JSON.parse(secondPage)].flatMap(
    (page: { data: { id: string }[] }) => page.data,
  );
  const page = JSON.parse(firstPage);
  page.data = ["ogn-001-298", "ogn-299-298", "unl-205-219"].map((id) => records.find((record) => record.id === id));
  page.metadata.totalItems = 3;
  page.metadata.totalPages = 1;
  page.linkdata.last = page.linkdata.first;
  delete page.linkdata.next;
  return JSON.stringify(page);
}

/** A synthetic PNG signature and IHDR declaring the URL's dimensions, padded to `size`. */
function png(width: number, height: number, size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("a Riot refresh retains every front, including one above the former 2 MiB bound, and skips them unchanged next time", async () => {
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const page = envelope();
  const large = 3 * 1024 * 1024;
  const requested: string[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL) {
      const url = new Request(input).url;
      requested.push(url);
      if (url === inventory) return new Response(page, { headers: { "content-type": "application/json" } });
      const [, width, height] = /-(\d+)x(\d+)\.png/u.exec(url)!;
      return new Response(png(Number(width), Number(height), url.includes("-1488x2078.") ? large : 64 * 1024), {
        headers: { "content-type": "image/png" },
      });
    },
  } as Fetcher;
  const collect = async (key: string) => {
    const started = await startEvidenceRun(db, {
      acquisition_budget: fixtureAcquisitionBudget,
      idempotency_key: key,
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          subset: "public-english-inventory",
          requests: [{ id: "riftbound-en:catalogue", url: inventory }],
        },
      ],
    });
    const runId = String(started.id);
    await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, runId);
    return runId;
  };

  const runId = await collect("riot-image-refresh");
  const fronts = requested.filter((url) => url !== inventory);
  expect(fronts).toHaveLength(3);
  expect(fronts.filter((url) => url.includes("-1488x2078."))).toHaveLength(1);
  const candidate = await prepareNativeEvidence({
    runId,
    game: "riftbound",
    predecessor: "catrev_spine_000",
    key: "riot-image-refresh-candidate",
  });
  const records = await nativeCandidateRecords(requiredString(candidate, "id"), [
    "printings",
    "printing_images",
    "warnings",
  ]);
  // Each front is retained evidence, so every Printing qualifies automatically.
  expect(records.printings).toHaveLength(3);
  expect(records.printing_images).toHaveLength(3);
  expect((records.warnings ?? []).filter((warning) => warning.code === "printing_image_unavailable")).toEqual([]);

  requested.length = 0;
  await collect("riot-image-refresh-again");
  expect(requested).toEqual([inventory]);
});
