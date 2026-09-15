import { expect, test } from "vitest";
import { catalogueStore, canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import {
  insertAuthoredCuratedRevisionStatement,
  insertCuratedAuthoredEventStatement,
} from "../../../src/catalogue/curated/curated-repository";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { seedNativePredecessor, prepareNativeCandidate } from "./native-publication-helpers";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

installReconciliationSuite({ directPreparation: true });

test("a native candidate preserves the exact historical Curated proposal in evidence inspection", async () => {
  const run = await collect("/reconciliation/inspection-product", "retained-curated-seed");
  const seed = await prepareNativeCandidate(run.id, "one-piece", "catrev_spine_000", "retained-curated-seed-candidate");
  const cards = (await nativeCandidateRecords(requiredString(seed, "id"), ["cards"])).cards as {
    id: string;
    name: string;
  }[];
  const card = cards[0]!;
  const published = await seedNativePredecessor(seed, "retained-curated-predecessor");
  expect(published.checkpoint).toBe("pending");
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: card.id, path: "/name" },
    assertion: { kind: "field", value: "Historical owner name" },
    rationale: "Retained review.",
    evidence: [{ kind: "owner_reference", uri: "https://owner.example/retained", content_digest: "a".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(card.name)),
    supersedes_revision_id: null,
    "": "historically acknowledged",
    later: { exact: [1, null] },
  };
  Object.defineProperty(proposal, "__proto__", { value: { retained: true }, enumerable: true });
  await insertAuthoredCuratedRevisionStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    revisionId: "currev_historical_native",
    game: "one-piece",
    targetKey: `one-piece|field|card|${card.id}|/name`,
    targetKind: "field",
    effectiveFrom: null,
    effectiveTo: null,
    proposalJson: canonicalJson(proposal),
    contentDigest: await sha256Text(canonicalJson(proposal)),
    reviewedSourceDigest: proposal.reviewed_source_digest,
    schemaBindingJson: canonicalJson({ catalogue_revision_id: published.revisionId, game_profile: "one-piece@1" }),
    observedAt: new Date().toISOString(),
  }).run();
  await insertCuratedAuthoredEventStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    revisionId: "currev_historical_native",
    eventJson: canonicalJson({ reviewed_source_digest: proposal.reviewed_source_digest }),
    observedAt: new Date().toISOString(),
  }).run();
  const next = await collect("/reconciliation/inspection-product", "retained-curated-next");
  const candidate = await prepareNativeCandidate(
    next.id,
    "one-piece",
    published.revisionId,
    "retained-curated-next-candidate",
  );
  const id = requiredString(candidate, "id");
  const inspected = await get(`/v1/game-candidates/${id}/inspection/evidence/curated`);
  expect(inspected.response.status, JSON.stringify(inspected.document)).toBe(200);
  expect(inspected.document.records).toEqual([expect.objectContaining({ proposal, active: 1 })]);
  await assertHttpResponse(
    contract,
    "/v1/game-candidates/{candidate}/inspection/evidence/{kind}",
    "get",
    inspected.response,
    inspected.document,
  );
  expect((await nativeCandidateRecords(id, ["cards"])).cards).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: card.id, name: "Historical owner name" })]),
  );
});
