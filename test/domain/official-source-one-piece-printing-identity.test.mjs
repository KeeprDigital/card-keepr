import { test } from "vitest";
import assert from "node:assert/strict";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation.ts";
import { retainedOfficialSourceFixture, retainedRestructuredParse } from "./official-source-raw-contract-shared.mjs";

// Bandai's live card list publishes no artwork attribute, so every Printing of
// a number shared one artwork fingerprint and 1,857 Printings of the full
// English scope could not be matched by evidence. The owner designated the
// front-image file stem the Official Source artwork identity (issue #334).
const seriesPage = "one-piece-en-card-list-op16-series";
const context = {
  url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  requestId: "one-piece-en:card-list",
};

function retained() {
  return retainedRestructuredParse(requiredSourceAdapter("one-piece-en@6"), seriesPage, context).observations;
}

test("the retained page carries no artwork attribute at all", () => {
  const { bytes } = retainedOfficialSourceFixture(seriesPage);
  assert.equal(bytes.toString("utf8").includes("data-artwork-id"), false);
});

test("every retained record gets its own artwork identity", () => {
  const observations = retained();
  assert.equal(observations.length, 155);
  const fingerprints = observations.map(({ identity_evidence }) => identity_evidence.artwork_fingerprint);
  assert.equal(
    fingerprints.every((value) => /"artwork_id":"[^"]+"/u.test(value)),
    true,
    "no record falls back to a null artwork identity",
  );
  // 155 records, 155 distinct front images, 155 distinct identities.
  assert.equal(new Set(fingerprints).size, 155);
});

test("a base Printing and its parallel are distinguishable by retained evidence", () => {
  const observations = retained();
  const base = observations.find(({ identity_evidence }) => identity_evidence.locator === "OP16-001");
  const parallel = observations.find(({ identity_evidence }) => identity_evidence.locator === "OP16-001_p1");
  assert.ok(base && parallel, "the page lists the Leader and its parallel");
  assert.notEqual(base.identity_evidence.artwork_fingerprint, parallel.identity_evidence.artwork_fingerprint);
  assert.match(base.identity_evidence.artwork_fingerprint, /"artwork_id":"op16-001"/u);
  assert.match(parallel.identity_evidence.artwork_fingerprint, /"artwork_id":"op16-001_p1"/u);
  // Reconciliation can now treat the identity as explicit evidence.
  for (const observation of [base, parallel]) {
    const parsed = parseReconciliationObservation(`srcobs_${observation.identity_evidence.locator}`, observation);
    assert.equal(parsed.artworkIdentityExplicit, true);
  }
});

test("a redistributed front image still establishes no artwork identity", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { bytes, metadata } = retainedOfficialSourceFixture(seriesPage);
  // A CDN filename is not the Publisher's per-Printing asset name, so a changed
  // source image alone must not create a Printing.
  const html = bytes
    .toString("utf8")
    .replaceAll("OP16-001.png?260828", "unrelated-distribution-filename.webp?width=2048");
  const observations = adapter.parseBytes(new TextEncoder().encode(html), {
    mediaType: metadata.content_type,
    ...context,
  });
  const base = observations.find(({ identity_evidence }) => identity_evidence.locator === "OP16-001");
  assert.ok(base);
  assert.match(base.identity_evidence.artwork_fingerprint, /"artwork_id":null/u);
  assert.equal(parseReconciliationObservation("srcobs_redistributed", base).artworkIdentityExplicit, false);
});
