import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import { seedCompositionSmoke } from "./helpers/query-helpers/composition-smoke.mjs";
const bundle = await build({
  stdin: {
    contents:
      'export { productionReleaseSmokeTargets } from "./src/catalogue/ingestion/administration-inspection"; export { compositionEntityResponse } from "./src/catalogue/read/composition-read"; export { catalogueStore } from "./src/catalogue/shared/catalogue-store-repository";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const migrations = await Promise.all(
  (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map((n) => readFile(`migrations/${n}`, "utf8")),
);
for (const defect of [null, "older-image-free", "missing-image", "missing-printing", "corrupt-card", "missing-search"])
  test(`native release smoke target selection: ${defect ?? "consumer cursor roundtrip"}`, async (t) => {
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    for (const sql of migrations) db.exec(sql);
    const revisions = seedCompositionSmoke(db, defect);
    const store = runtime.catalogueStore(d1Adapter(db));
    const targets = await runtime.productionReleaseSmokeTargets(store, revisions);
    if (defect && defect !== "older-image-free") {
      assert.equal(targets, null);
      return;
    }
    assert.ok(targets);
    assert.equal(targets.printing_image_id, "image_a");
    for (const revision of targets.revisions) {
      assert.equal(revision.search_query, "searchable curated card");
      for (const [kind, cursor, expectedId, query] of [
        ["cards", revision.card_cursor, revision.card_id, ""],
        ["cards", revision.search_cursor, revision.card_id, `&q=${encodeURIComponent(revision.search_query)}`],
        ["printings", revision.printing_cursor, revision.printing_id, ""],
      ]) {
        const response = await runtime.compositionEntityResponse(
          store,
          new Request(`https://catalogue.test/v1/${kind}?after=${encodeURIComponent(cursor)}${query}`),
          { origin: "https://catalogue.test", basePath: "" },
          kind,
        );
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.meta.catalogue_revision_id, revision.revision_id);
        assert.ok(page.data.some((v) => v.id === expectedId));
      }
    }
    await assert.rejects(
      runtime.compositionEntityResponse(
        store,
        new Request(`https://catalogue.test/v1/cards?after=${encodeURIComponent(targets.stale_cursor)}`),
        { origin: "https://catalogue.test", basePath: "" },
        "cards",
      ),
      (e) => e.code === "cursor_revision_unavailable",
    );
  });
