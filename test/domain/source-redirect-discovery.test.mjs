import { test } from "vitest";
import assert from "node:assert/strict";
import {
  registrableDomain,
  sameSiteRedirectTarget,
  toleratesRequestFailure,
  redirectDiscoveredFailureCode,
} from "../../src/catalogue/source-evidence/source-evidence-model.ts";

// The #334 shakedown found live Bandai product links answered by same-site
// redirects: products/boosters/op13.php -> /products/boosters/op13/ (also op09,
// op05). The redirect is retained as evidence and its Location continues as a
// newly discovered Source Request; cross-site targets still fail.

test("the live Bandai product redirects resolve to same-site discoveries", () => {
  for (const number of ["op13", "op09", "op05"]) {
    const origin = `https://en.onepiece-cardgame.com/products/boosters/${number}.php`;
    const expected = `https://en.onepiece-cardgame.com/products/boosters/${number}/`;
    assert.equal(sameSiteRedirectTarget(origin, `/products/boosters/${number}/`), expected);
    assert.equal(sameSiteRedirectTarget(origin, expected), expected);
  }
});

test("only same-registrable-domain HTTPS targets are discoveries", () => {
  const origin = "https://en.onepiece-cardgame.com/products/boosters/op13.php";
  assert.equal(
    sameSiteRedirectTarget(origin, "https://www.onepiece-cardgame.com/x/"),
    "https://www.onepiece-cardgame.com/x/",
  );
  assert.equal(sameSiteRedirectTarget(origin, "https://elsewhere.example/op13/"), null);
  assert.equal(sameSiteRedirectTarget(origin, "http://en.onepiece-cardgame.com/op13/"), null);
  assert.equal(sameSiteRedirectTarget(origin, "https://user:pass@en.onepiece-cardgame.com/op13/"), null);
  assert.equal(sameSiteRedirectTarget(origin, null), null);
  assert.equal(sameSiteRedirectTarget(origin, ""), null);
  // A redirect to itself (ignoring the fragment) discovers nothing.
  assert.equal(sameSiteRedirectTarget(origin, "#top"), null);
  assert.equal(registrableDomain("en.onepiece-cardgame.com"), "onepiece-cardgame.com");
  assert.equal(registrableDomain("www.bandai.co.jp"), "bandai.co.jp");
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("official-source.invalid"), "official-source.invalid");
  assert.notEqual(registrableDomain("a.co.jp"), registrableDomain("b.co.jp"));
});

test("a redirect discovery is tolerated for page roles only", () => {
  for (const role of ["listing", "detail", "product_detail"])
    assert.equal(toleratesRequestFailure(role, redirectDiscoveredFailureCode), true, role);
  for (const role of ["surface", "image"])
    assert.equal(toleratesRequestFailure(role, redirectDiscoveredFailureCode), false, role);
  assert.equal(toleratesRequestFailure("listing", "source_redirect_rejected"), false);
  assert.equal(toleratesRequestFailure("image", "source_image_redirected"), true);
});
