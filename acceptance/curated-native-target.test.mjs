import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  addCuratedErratumMembership,
  addCuratedProductFixture,
  appendCuratedText,
  corruptCuratedCheckpoint,
  corruptCuratedFixture,
  corruptCuratedProduct,
  curatedNativeFixture,
  removeCuratedProductCheckpoint,
  requireCuratedCorrection,
  retireCuratedFixture,
  unpublishCuratedFixture,
  wrongGameCuratedProduct,
} from "./helpers/query-helpers/curated-native-fixture.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const proposal = () => ({
  game: "riftbound",
  target: { kind: "field", entity_type: "printing", entity_id: "printing_monk", path: "/printed_rules_text" },
  assertion: { kind: "field", value: "Reviewed printed wording" },
  rationale: "Reviewed retained publisher image.",
  evidence: [{ kind: "owner_reference", uri: "https://example.com/monk.png", content_digest: "a".repeat(64) }],
  effective_interval: { from: null, to: null },
  reviewed_source_digest: digest(null),
  supersedes_revision_id: null,
});

test("Curated validation resolves a published native Printing through its exact game component", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-curated-native-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "validation.mjs");
  await build({
    stdin: {
      contents: `export { validateCuratedRevision } from './src/catalogue/curated/index.ts'; export { catalogueStore } from './src/catalogue/shared/index.ts';`,
      resolveDir: resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: output,
    logLevel: "silent",
  });
  const { validateCuratedRevision, catalogueStore } = await import(pathToFileURL(output).href);
  const fixture = curatedNativeFixture();
  t.after(() => fixture.db.close());
  await t.test("native validation does not generate code during the request", async () => {
    const OriginalFunction = globalThis.Function;
    const originalError = console.error;
    // biome-ignore lint/complexity/useArrowFunction: the replacement must remain constructible to reproduce new Function rejection.
    globalThis.Function = function () {
      throw new EvalError("Code generation from strings disallowed for this context");
    };
    console.error = () => {};
    try {
      const validated = await validateCuratedRevision(
        catalogueStore(d1Adapter(fixture.db)),
        proposal(),
        "composition_current",
      );
      assert.equal(validated.valid, true);
    } finally {
      globalThis.Function = OriginalFunction;
      console.error = originalError;
    }
  });
  const result = await validateCuratedRevision(
    catalogueStore(d1Adapter(fixture.db)),
    proposal(),
    "composition_current",
  );
  assert.equal(result.valid, true);
  assert.equal(result.schema_binding.catalogue_revision_id, "composition_current");
  await t.test("native Card fields resolve in the same published game component", async () => {
    const p = proposal();
    p.target = { kind: "field", entity_type: "card", entity_id: "card_monk", path: "/game_data/attributes/tags" };
    p.assertion.value = ["Ionia"];
    p.reviewed_source_digest = digest([]);
    assert.equal(
      (await validateCuratedRevision(catalogueStore(d1Adapter(fixture.db)), p, "composition_current")).valid,
      true,
    );
  });
  await t.test("native Product, Release, context and relationship retain official source authority", async () => {
    const f = curatedNativeFixture();
    try {
      addCuratedProductFixture(f);
      for (const [type, id, path, source, value] of [
        ["product", "product_native", "/name", "Official product", "Reviewed product"],
        ["release", "release_native", "/status", "announced", "released"],
        ["distribution_context", "context_native", "/label", "Official context", "Reviewed context"],
      ]) {
        const p = proposal();
        p.target = { kind: "field", entity_type: type, entity_id: id, path };
        p.assertion.value = value;
        p.reviewed_source_digest = digest(source);
        assert.equal(
          (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current")).valid,
          true,
        );
      }
      const p = proposal();
      p.target = {
        kind: "relationship",
        relationship_kind: "printing-product",
        from: { type: "printing", id: "printing_monk" },
        to: { type: "product", id: "product_native" },
      };
      p.assertion = { kind: "relationship", presence: "absent" };
      p.reviewed_source_digest = digest("present");
      assert.equal(
        (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current")).valid,
        true,
      );
    } finally {
      f.db.close();
    }
  });
  for (const [name, change, expected] of [
    ["missing Product checkpoint", removeCuratedProductCheckpoint, "curated_revision_target_unavailable"],
    [
      "incomplete Product checkpoint",
      (f) => f.checkpoint("product_reduction:riftbound", { stage: "inputs", result: { products: 1 } }),
      "curated_revision_target_unavailable",
    ],
    ["corrupt Product record", corruptCuratedProduct, "curated_revision_target_unavailable"],
    ["wrong Product game", wrongGameCuratedProduct, "curated_revision_target_unavailable"],
  ])
    await t.test(name, async () => {
      const f = curatedNativeFixture();
      try {
        addCuratedProductFixture(f);
        change(f);
        const p = proposal();
        p.target = { kind: "field", entity_type: "product", entity_id: "product_native", path: "/name" };
        p.assertion.value = "Reviewed product";
        p.reviewed_source_digest = digest("Official product");
        await assert.rejects(validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current"), {
          code: expected,
        });
      } finally {
        f.db.close();
      }
    });
  await t.test("Erratum source fields survive native lookup", async () => {
    const f = curatedNativeFixture();
    try {
      addCuratedErratumMembership(f);
      f.checkpoint("curated_revisions", { progress: { stage: "complete" }, official: { errata: 1 }, curated: {} });
      f.entity("candidate_before_curated_errata", {
        id: "erratum_native",
        game: "riftbound",
        effective_from: null,
        official_wording: "Official wording",
        corrected_value: null,
      });
      const p = proposal();
      p.target = { kind: "field", entity_type: "erratum", entity_id: "erratum_native", path: "/official_wording" };
      p.assertion.value = "Reviewed wording";
      p.reviewed_source_digest = digest("Official wording");
      assert.equal(
        (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current")).valid,
        true,
      );
    } finally {
      f.db.close();
    }
  });
  await t.test("later game overlays and Curated source presence survive SQLite backup and restore", async () => {
    const f = curatedNativeFixture();
    const p = proposal();
    p.target = {
      kind: "relationship",
      relationship_kind: "printing-product",
      from: { type: "printing", id: "printing_monk" },
      to: { type: "product", id: "product_native" },
    };
    p.assertion = { kind: "relationship", presence: "absent" };
    p.reviewed_source_digest = digest("absent");
    try {
      addCuratedProductFixture(f);
      f.checkpoint("official_errata", {
        errataComplete: true,
        productGames: ["riftbound", "gundam"],
        prior: { priorProducts: {} },
      });
      f.checkpoint("product_reduction:gundam", { stage: "complete", result: { product_relationships: 1 } });
      f.entity("candidate_product_result_gundam_product_relationships", {
        id: "relationship_native",
        game: "riftbound",
        kind: "printing-product",
        from: p.target.from,
        to: p.target.to,
        observed: true,
        evidence_category: "explicit",
        curated_provenance: [{ reviewed_source_value: "absent" }],
      });
      assert.equal(
        (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current")).valid,
        true,
      );
      const restoredPath = join(directory, "product-restore.sqlite");
      await backup(f.db, restoredPath);
      const restored = new DatabaseSync(restoredPath);
      try {
        assert.equal(
          (await validateCuratedRevision(catalogueStore(d1Adapter(restored)), p, "composition_current")).valid,
          true,
        );
        p.reviewed_source_digest = digest("present");
        await assert.rejects(validateCuratedRevision(catalogueStore(d1Adapter(restored)), p, "composition_current"), {
          code: "curated_revision_reviewed_source_mismatch",
        });
      } finally {
        restored.close();
      }
    } finally {
      f.db.close();
    }
  });
  for (const [name, change, expected] of [
    [
      "missing required correction checkpoint",
      (f) => requireCuratedCorrection(f.db),
      "curated_revision_target_unavailable",
    ],
    [
      "wrong game",
      (_f, p) => {
        p.game = "one-piece";
      },
      "curated_revision_target_invalid",
    ],
    [
      "missing target",
      (_f, p) => {
        p.target.entity_id = "printing_missing";
      },
      "curated_revision_target_not_found",
    ],
    ["unpublished member", (f) => unpublishCuratedFixture(f.db), "curated_revision_target_not_found"],
    ["retired query state", (f) => retireCuratedFixture(f.db), "curated_revision_target_unavailable"],
    ["corrupt private digest", (f) => corruptCuratedFixture(f.db), "curated_revision_target_unavailable"],
    ["corrupt checkpoint", (f) => corruptCuratedCheckpoint(f.db), "curated_revision_target_unavailable"],
  ])
    await t.test(name, async () => {
      const f = curatedNativeFixture(),
        p = proposal();
      try {
        change(f, p);
        await assert.rejects(validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current"), {
          code: expected,
        });
      } finally {
        f.db.close();
      }
    });
  await assert.rejects(
    validateCuratedRevision(catalogueStore(d1Adapter(fixture.db)), proposal(), "game_revision_earlier"),
    { code: "current_revision_mismatch" },
  );
  await t.test("checkpoint excludes a later uncommitted entity", async () => {
    const f = curatedNativeFixture();
    try {
      f.entity(
        "candidate_before_curated_printings",
        { id: "printing_monk", card_id: "card_monk", printed_rules_text: "uncommitted" },
        2,
      );
      assert.equal(
        (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), proposal(), "composition_current")).valid,
        true,
      );
    } finally {
      f.db.close();
    }
  });
  await t.test("correction precedence retains original reviewed source beneath curated wording", async () => {
    const f = curatedNativeFixture();
    try {
      const p = proposal();
      const provenance = { target: p.target, reviewed_source_value: null };
      f.checkpoint("curated_revisions", {
        progress: { stage: "complete" },
        official: { cards: 1, printings: 1 },
        curated: { printings: 1 },
      });
      f.entity("candidate_curated_printings", {
        id: "printing_monk",
        card_id: "card_retired_by_correction",
        printed_rules_text: "curated text",
        curated_provenance: [provenance],
        rarity: { normalized: "uncommon", raw: "Uncommon" },
        game_data: null,
      });
      requireCuratedCorrection(f.db);
      f.checkpoint("identity_application", { stage: "complete", positions: { printings: 1 } });
      f.entity("candidate_corrections_printings", {
        id: "printing_monk",
        card_id: "card_monk",
        printed_rules_text: "corrected curated text",
        curated_provenance: [provenance],
        rarity: { normalized: "uncommon", raw: "Uncommon" },
        game_data: null,
      });
      const store = catalogueStore(d1Adapter(f.db));
      assert.equal((await validateCuratedRevision(store, p, "composition_current")).valid, true);
      p.reviewed_source_digest = digest("corrected curated text");
      await assert.rejects(validateCuratedRevision(store, p, "composition_current"), {
        code: "curated_revision_reviewed_source_mismatch",
      });
    } finally {
      f.db.close();
    }
  });
  await t.test("retained private text is hydrated and verified before the source comparison", async () => {
    const f = curatedNativeFixture();
    try {
      const text = "Original printed wording",
        sha = createHash("sha256").update(text).digest("hex");
      f.checkpoint("curated_revisions", {
        progress: { stage: "complete" },
        official: { cards: 1, printings: 2 },
        curated: {},
      });
      f.entity(
        "candidate_before_curated_printings",
        {
          id: "printing_monk",
          card_id: "card_monk",
          printed_rules_text: null,
          rarity: { normalized: "uncommon", raw: "Uncommon" },
          game_data: null,
        },
        2,
        [{ path: ["entity", "printed_rules_text"], sha256: sha, chunks: 1, byte_length: Buffer.byteLength(text) }],
      );
      appendCuratedText(f.db, sha, text);
      const p = proposal();
      p.reviewed_source_digest = digest(text);
      assert.equal(
        (await validateCuratedRevision(catalogueStore(d1Adapter(f.db)), p, "composition_current")).valid,
        true,
      );
    } finally {
      f.db.close();
    }
  });
});
