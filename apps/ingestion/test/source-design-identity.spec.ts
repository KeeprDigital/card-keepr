import { nativeDiagnosticRecords } from "./query-helpers/native-diagnostic-records";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { reconciliationSourceDocument } from "../../../test/support/fake-publisher/reconciliation-documents";
import { get, post, postFixtureEvidence, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { prepareNativeEvidence, approveNativeCandidate } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";

installReconciliationSuite({ directPreparation: true });

type SyntheticObservation = Record<string, unknown> & {
  card: { name: string; official_identity: { kind: string; value: string | null } };
  card_identity_evidence: { source_design_key: string };
  identity_evidence: { locator: string; variant_key: string; treatment: string; artwork_fingerprint: string };
  appearance_evidence: { images: Record<string, unknown>[] };
};

function observation(locator: string, key: string, variant = "base") {
  const source = reconciliationSourceDocument("inspection-base", "discovery", "https://official-source.invalid/design");
  const value = structuredClone(source!.cards![0]!) as unknown as SyntheticObservation;
  value.card.official_identity = { kind: "unknown", value: null };
  value.card_identity_evidence = { source_design_key: key };
  value.identity_evidence.locator = locator;
  value.identity_evidence.variant_key = variant;
  value.identity_evidence.treatment = variant;
  value.memberships = { products: [], distribution_contexts: [], source_buckets: [] };
  delete value.product_release_catalogue;
  return value;
}

async function prepare(
  values: unknown[],
  key: string,
  predecessor = "catrev_spine_000",
  options: {
    lineage?: string;
    expectedState?: "sealed" | "failed";
    image?: Uint8Array;
  } = {},
) {
  const lineage = options.lineage ?? "one-piece-en";
  const imageUrl = "https://official-source.invalid/design.png";
  const started = await postFixtureEvidence({
    supported_game: "one-piece",
    source_lineage: lineage,
    adapter_version: `fixture-design-${lineage}@1`,
    idempotency_key: key,
    requests: [
      { id: "design", url: "https://official-source.invalid/design", headers: { accept: "application/json" } },
    ],
  });
  const transport = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      return request.url === imageUrl
        ? new Response(options.image, { headers: { "content-type": "image/png" } })
        : Response.json({ cards: values });
    },
  } as unknown as Fetcher;
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, String(started.document.id));
  const candidate = await prepareNativeEvidence({
    runId: String(started.document.id),
    game: "one-piece",
    predecessor,
    key: `${key}-candidate`,
    expectedState: options.expectedState,
  });
  return {
    candidate,
    records: options.expectedState === "failed" ? null : await nativeCandidateRecords(String(candidate.id)),
  };
}

test("qualified designs separate equal facts, share finishes and retain IDs across refresh and explicit key review", async () => {
  const values = [
    observation("record-a", "qualified:a"),
    observation("record-a", "qualified:a", "foil"),
    observation("record-b", "qualified:b"),
  ];
  const first = await prepare(values, "design-base");
  expect(first.records!.cards).toHaveLength(2);
  expect(first.records!.printings).toHaveLength(3);
  const publication = await approveNativeCandidate(first.candidate, "design-publish");
  const predecessor = String(publication.document.resulting_revision_id);
  const cardIds = first.records!.cards!.map((c) => c.id).sort();
  const printingIds = first.records!.printings!.map((p) => p.id).sort();
  const proposals = (await get("/v1/entity-proposals?game=one-piece")).document.proposals as {
    id: string;
    reference: string;
  }[];
  const a = proposals.find((p) => p.reference === JSON.stringify(["record-a", "base"]))!;
  const before = (await get(`/v1/entity-proposals/${a.id}`)).document;
  const refreshed = await prepare(values, "design-refresh", predecessor);
  expect(refreshed.records!.cards!.map((c) => c.id).sort()).toEqual(cardIds);
  expect(refreshed.records!.printings!.map((p) => p.id).sort()).toEqual(printingIds);
  const refreshPublication = await approveNativeCandidate(refreshed.candidate, "design-refresh-publish");
  const changed = structuredClone(values);
  changed[0]!.card_identity_evidence.source_design_key = "qualified:changed";
  const blocked = await prepare(
    changed,
    "design-key-change",
    String(refreshPublication.document.resulting_revision_id),
    { expectedState: "failed" },
  );
  const outcome = (await get(`/v1/game-candidates/${blocked.candidate.id}`)).document;
  expect(outcome).toMatchObject({ failure_code: "printing_reconciliation_blocked" });
  expect(await nativeDiagnosticRecords(testEnv.CATALOGUE_DB, String(blocked.candidate.id))).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "canonical_card_conflict" })]),
  );
  expect((await get(`/v1/entity-proposals/${a.id}`)).document.history).toEqual(before.history);
  const reconsider = await post(`/v1/entity-proposals/${a.id}/decisions`, {
    action: "reconsider",
    expected_generation: "1",
    rationale: "Synthetic source key correction inspected by owner",
    evidence: { ...(before.evidence as object), card_design_key: "qualified:changed" },
    idempotency_key: "design-reconsider",
  });
  expect(reconsider.response.status, JSON.stringify(reconsider.document)).toBe(200);
  const admitted = await post(`/v1/entity-proposals/${a.id}/decisions`, {
    action: "admit",
    expected_generation: "2",
    rationale: "Retain the inspected Card and Printing allocation",
    idempotency_key: "design-readmit",
  });
  expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
  const resolved = await prepare(changed, "design-resolved", String(refreshPublication.document.resulting_revision_id));
  expect(resolved.records!.cards!.map((c) => c.id).sort()).toEqual(cardIds);
  expect(resolved.records!.printings!.map((p) => p.id).sort()).toEqual(printingIds);
});

test("unqualified source design strings cannot associate different Card facts", async () => {
  const first = observation("one", "unqualified:shared");
  const second = observation("two", "unqualified:shared");
  second.card.name = "Different synthetic Card";
  const prepared = await prepare([first, second], "unqualified-design");
  expect(prepared.records!.cards).toHaveLength(2);
});

test("the same qualified design string in another Source Lineage is not a cross-source identity", async () => {
  const value = observation("record-a", "qualified:shared");
  const first = await prepare([value], "namespace-first");
  const publication = await approveNativeCandidate(first.candidate, "namespace-publish");
  for (const area of ["card_facts", "printing_details"]) {
    const selected = await post("/v1/source-authorities", {
      game: "one-piece",
      locale: "en",
      release_region: "OCEANIA",
      area,
      source_lineage: "limitless-one-piece-en",
      expected_generation: 0,
      rationale: "Synthetic independent-source namespace proof",
      idempotency_key: `namespace-${area}`,
    });
    expect(selected.response.status, JSON.stringify(selected.document)).toBe(200);
  }
  const second = await prepare([value], "namespace-second", String(publication.document.resulting_revision_id), {
    lineage: "limitless-one-piece-en",
  });
  expect(second.records!.cards).toHaveLength(2);
  expect(new Set(second.records!.printings!.map((p) => p.card_id)).size).toBe(2);
});

test.each([false, true])(
  "retained capture cannot overwrite source-declared image digest (matching %s)",
  async (matching) => {
    // Real PNG encoding, synthetic catalogue identity; exercises capture and attach, not just the pure parser.
    const image = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII="),
      (c) => c.charCodeAt(0),
    );
    const value = observation("image-record", "qualified:image");
    value.appearance_evidence.images = [
      {
        role: "front",
        source_url: "https://official-source.invalid/design.png",
        artwork_fingerprint: value.identity_evidence.artwork_fingerprint,
        content_sha256: matching ? createHash("sha256").update(image).digest("hex") : "0".repeat(64),
      },
    ];
    const prepared = await prepare([value], `image-${matching}`, "catrev_spine_000", { image });
    expect(prepared.records!.printings ?? [], JSON.stringify(prepared.records)).toHaveLength(matching ? 1 : 0);
    expect(prepared.records!.printing_images ?? []).toHaveLength(matching ? 1 : 0);
  },
);
