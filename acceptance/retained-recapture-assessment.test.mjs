import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { createOfficialSourceAssessment } from "../scripts/official-source-recapture-assessment.mjs";

const fixturesDirectory = new URL("./fixtures/retained-official-source/", import.meta.url).pathname;
const assess = await createOfficialSourceAssessment({ fixturesDirectory });
const name = "fusion-world-en-card-detail-battle.json";
const golden = JSON.parse(await readFile(new URL(name, `file://${fixturesDirectory}`), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function assessment(body) {
  const bytes = Buffer.from(body);
  return assess({
    name,
    golden,
    actual: { ...golden, full_body_sha256: digest(bytes) },
    bytes,
    differences: digest(bytes) === golden.full_body_sha256 ? [] : ["full_body_sha256"],
  });
}

test("recapture calls the current adapter and distinguishes cosmetic bytes from Card facts", async () => {
  const html = Buffer.from(golden.body_base64, "base64").toString("utf8");
  const cosmetic = await assessment(`${html}\n<!-- publisher deployment marker -->`);
  assert.equal(cosmetic.category, "cosmetic_drift");
  assert.equal(cosmetic.actionable, false);
  assert.equal(cosmetic.adapter_version, "fusion-world-en@9");
  const semantic = await assessment(html.replaceAll("Krillin", "Changed publisher card name"));
  assert.equal(semantic.category, "semantic_drift");
  assert.equal(semantic.actionable, true);
  assert.ok(semantic.changed_paths.some((path) => path.includes("name")));
  const broken = await assessment("<html>Site temporarily unavailable</html>");
  assert.equal(broken.category, "structural_drift");
  assert.equal(broken.actionable, true);
});

test("offline reassessment rejects corrupted complete evidence and reports old truncated captures explicitly", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { assessRetainedRecapture } = await import("../scripts/assess-official-recapture.mjs");
  const directory = await mkdtemp(join(tmpdir(), "keepr-recapture-replay-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify({ captures: [{ file: name, status: "drift", differences: ["full_body_sha256"] }] }),
  );
  await writeFile(join(directory, name), JSON.stringify({ ...golden, full_body_file: `${"0".repeat(64)}.body` }));
  await writeFile(join(directory, `${"0".repeat(64)}.body`), "corrupt response");
  const corrupt = await assessRetainedRecapture({
    fixturesDirectory,
    captureDirectory: directory,
    outputFile: join(directory, "corrupt.json"),
  });
  assert.equal(corrupt.captures[0].category, "integrity_failure");
  assert.equal(corrupt.ok, false);
  await writeFile(join(directory, name), JSON.stringify({ ...golden, full_body_size: golden.full_body_size + 10 }));
  const partial = await assessRetainedRecapture({
    fixturesDirectory,
    captureDirectory: directory,
    outputFile: join(directory, "partial.json"),
  });
  assert.equal(partial.captures[0].category, "unresolved_drift");
  assert.match(partial.captures[0].reason, /discarded bytes/u);
});

test("a separately reviewed complete baseline accepts only its exact adapter meaning and verifies its bytes", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { gzipSync } = await import("node:zlib");
  const directory = await mkdtemp(join(tmpdir(), "keepr-reviewed-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const body = Buffer.from(
    Buffer.from(golden.body_base64, "base64").toString("utf8").replaceAll("Krillin", "Reviewed card name"),
  );
  const baseline = {
    ...golden,
    range_start: 0,
    range_end_exclusive: body.length,
    full_body_size: body.length,
    body_base64: body.toString("base64"),
    body_sha256: digest(body),
    full_body_sha256: digest(body),
  };
  await writeFile(join(directory, "baselines.json"), JSON.stringify({ [name]: { full_body_sha256: digest(body) } }));
  await writeFile(join(directory, `${name}.gz`), gzipSync(JSON.stringify(baseline)));
  const reviewed = await createOfficialSourceAssessment({ fixturesDirectory, reviewedBaselinesDirectory: directory });
  const accepted = await reviewed({ name, golden, actual: baseline, bytes: body, differences: ["full_body_sha256"] });
  assert.equal(accepted.category, "unchanged");
  assert.equal(accepted.actionable, false);
  const future = Buffer.from(body.toString().replaceAll("Reviewed card name", "Future card name"));
  assert.equal(
    (await reviewed({ name, golden, actual: baseline, bytes: future, differences: ["full_body_sha256"] })).category,
    "semantic_drift",
  );
  await writeFile(join(directory, `${name}.gz`), gzipSync(JSON.stringify({ ...baseline, body_base64: "corrupt" })));
  const corrupt = await createOfficialSourceAssessment({ fixturesDirectory, reviewedBaselinesDirectory: directory });
  assert.equal(
    (await corrupt({ name, golden, actual: baseline, bytes: body, differences: [] })).category,
    "integrity_failure",
  );
});

test("reviewed display permutations and three decorative tokens preserve exact raw evidence without hiding content", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const reviewed = await createOfficialSourceAssessment({
    fixturesDirectory,
    reviewedBaselinesDirectory: join(fixturesDirectory, "monitoring"),
  });
  const fixture = async (directory, file) =>
    JSON.parse(gunzipSync(await readFile(join(fixturesDirectory, directory, `${file}.gz`))));
  const check = async (file, capture, html = Buffer.from(capture.body_base64, "base64").toString("utf8")) => {
    const source = JSON.parse(await readFile(join(fixturesDirectory, file), "utf8"));
    const body = Buffer.from(html);
    return reviewed({
      name: file,
      golden: source,
      actual: { ...capture, full_body_sha256: digest(body) },
      bytes: body,
      differences: ["full_body_sha256"],
    });
  };
  const repeats = "history/2026-09-09/cosmetic-repeat";
  for (const file of [
    "fusion-world-en-products-hub.json",
    "fusion-world-en-products-page2.json",
    "fusion-world-en-products-starter-tag.json",
    "gundam-en-asia-errata-listing.json",
  ]) {
    const capture = await fixture(repeats, file);
    const result = await check(file, capture);
    assert.equal(result.category, "cosmetic_drift");
    assert.equal(result.actionable, false);
    assert.ok(result.cosmetic_equivalence_rule);
    assert.notEqual(result.expected_observations_sha256, result.actual_observations_sha256);
    assert.ok(result.changes.length > 0);
  }
  const file = "fusion-world-en-products-hub.json";
  const capture = await fixture(repeats, file);
  const html = Buffer.from(capture.body_base64, "base64").toString("utf8");
  for (const changed of [
    html.replaceAll("Premium Card Collection 03", "Changed Card Collection"),
    html.replaceAll('class="cardInfoTxt">.</dd>', 'class="cardInfoTxt">September 18, 2026</dd>'),
    html.replaceAll("43.00 USD", "44.00 USD"),
  ])
    assert.equal((await check(file, capture, changed)).category, "semantic_drift");
  const sectionStart = html.indexOf('<section class="contentsColInner comingsoonCol" id="comingsoon">');
  const comingSoon = html.slice(sectionStart);
  const item = comingSoon.match(/<li class="prpductListItem cardCol">[\s\S]*?<\/li>/u)[0];
  const moved =
    html.slice(0, sectionStart).replace('<ul class="prpductList">', `<ul class="prpductList">${item}`) +
    comingSoon.replace(item, "");
  assert.equal((await check(file, capture, moved)).category, "semantic_drift");
  const errataName = "gundam-en-asia-errata-listing.json";
  const errata = await fixture(repeats, errataName);
  const errataHtml = Buffer.from(errata.body_base64, "base64").toString("utf8");
  assert.equal(
    (await check(errataName, errata, errataHtml.replaceAll("thumb_03.webp", "thumb_changed.webp"))).category,
    "semantic_drift",
  );
  assert.equal(
    (await check(errataName, errata, errataHtml.replace(/(\?_=[a-f0-9]{32})/gu, "$1&amp;extra=1"))).category,
    "semantic_drift",
  );
  const printingName = "gundam-en-asia-card-detail-dash-live.json";
  const printing = await fixture("monitoring", printingName);
  const printingHtml = Buffer.from(printing.body_base64, "base64").toString("utf8");
  // The Printing Image query token is evidence, never a reviewed decorative token.
  const imageToken = printingHtml.match(/GD02-016\.webp\?(\d{6})"/u)[1];
  assert.equal(
    (await check(printingName, printing, printingHtml.replaceAll(`?${imageToken}`, `?${Number(imageToken) + 1}`)))
      .category,
    "semantic_drift",
  );
  assert.equal((await check(file, capture, "<html>Publisher unavailable</html>")).category, "structural_drift");
});

test("same-day Gundam news items may permute; moved, relabeled or relinked items remain semantic", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const reviewed = await createOfficialSourceAssessment({
    fixturesDirectory,
    reviewedBaselinesDirectory: join(fixturesDirectory, "monitoring"),
  });
  const errataName = "gundam-en-asia-errata-listing.json";
  const source = JSON.parse(await readFile(join(fixturesDirectory, errataName), "utf8"));
  // Scheduled run 34952843408 recaptured the complete listing with its three
  // June 05, 2026 collaboration items rotated and the decorative tokens changed.
  const capture = JSON.parse(
    gunzipSync(await readFile(join(fixturesDirectory, "history/2026-09-15", `${errataName}.gz`))),
  );
  const html = Buffer.from(capture.body_base64, "base64").toString("utf8");
  const check = (body) => {
    const bytes = Buffer.from(body);
    return reviewed({
      name: errataName,
      golden: source,
      actual: { ...capture, full_body_sha256: digest(bytes) },
      bytes,
      differences: ["full_body_sha256"],
    });
  };
  const rotated = await check(html);
  assert.equal(rotated.category, "cosmetic_drift");
  assert.equal(rotated.actionable, false);
  assert.match(rotated.cosmetic_equivalence_rule, /same publication date/u);
  assert.notEqual(rotated.expected_observations_sha256, rotated.actual_observations_sha256);
  assert.ok(rotated.changes.some(({ path }) => path.includes("publication_links")));
  const items = html.split(/(?=<div class="newsDetail )/u).slice(1);
  const sameDay = items.filter((item) => item.includes("June 05, 2026"));
  assert.equal(sameDay.length, 3);
  const [first] = sameDay;
  const cut = first.indexOf('<span class="cardCategory">');
  const firstItem = first.slice(0, first.indexOf("</div>", cut) + "</div>".length);
  for (const changed of [
    html.replaceAll("gget-gcg-cp_1.html", "gget-gcg-cp_9.html"),
    html.replaceAll("[Join &amp; Get!] G Generation ETERNAL", "[Join &amp; Get!] Changed campaign"),
    html.replace('<dt class="cardDate">June 05, 2026</dt>', '<dt class="cardDate">June 06, 2026</dt>'),
    html.replace(firstItem, "").replace('<div class="newsBox">', `<div class="newsBox">${firstItem}`),
  ]) {
    const result = await check(changed);
    assert.equal(result.category, "semantic_drift");
    assert.equal(result.actionable, true);
  }
});

test("every reviewed monitoring baseline verifies its complete bytes and replays unchanged through the current adapter", async () => {
  const { gunzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const { validateGolden } = await import("../scripts/retained-source-integrity.mjs");
  const monitoring = join(fixturesDirectory, "monitoring");
  const reviewed = await createOfficialSourceAssessment({ fixturesDirectory, reviewedBaselinesDirectory: monitoring });
  const baselines = JSON.parse(await readFile(join(monitoring, "baselines.json"), "utf8"));
  const results = {};
  for (const [file, entry] of Object.entries(baselines)) {
    const golden = JSON.parse(await readFile(join(fixturesDirectory, file), "utf8"));
    const capture = JSON.parse(gunzipSync(await readFile(join(monitoring, `${file}.gz`))));
    validateGolden(capture);
    assert.equal(capture.source_url, golden.source_url, file);
    assert.equal(capture.source_url, entry.source_url, file);
    assert.equal(capture.retrieved_at, entry.retrieved_at, file);
    assert.equal(capture.full_body_sha256, entry.full_body_sha256, file);
    assert.ok(entry.reason.length > 0, file);
    const bytes = Buffer.from(capture.body_base64, "base64");
    const result = await reviewed({ name: file, golden, actual: capture, bytes, differences: [] });
    assert.equal(result.category, "unchanged", `${file}: ${result.reason ?? ""}`);
    assert.equal(result.actionable, false, file);
    results[file] = result;
  }
  // The 2026-09-15 Gundam card-search roots enumerate the four new ST11-ST14 packages.
  for (const file of ["gundam-en-asia-restructured-card-search.json", "gundam-en-us-restructured-card-search.json"]) {
    assert.equal(results[file].observation_count, 1, file);
    assert.equal(results[file].request_count, 25, file);
  }
  assert.equal(results["gundam-en-asia-card-list-complete-live.json"].request_count, 375);
});
