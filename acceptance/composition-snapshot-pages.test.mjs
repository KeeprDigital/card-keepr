import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { compositionSnapshotPageFixture } from "./helpers/query-helpers/composition-snapshot-pages.mjs";

test("private census SQL respects byte-limited partial pages without skipping row IDs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-snapshot-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "queries.mjs");
  await build({
    stdin: {
      contents:
        "export {compositionVerificationQuery,maximumSnapshotPageBytes} from './src/catalogue/backup-recovery/composition-verification-repository';",
      resolveDir: resolve("."),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const { compositionVerificationQuery, maximumSnapshotPageBytes } = await import(pathToFileURL(outfile).href);
  const fixture = compositionSnapshotPageFixture();
  t.after(() => fixture.db.close());
  const columns = fixture
    .query(compositionVerificationQuery({ kind: "composition-columns", table: "reconciliation_checkpoints" }))
    .map((row) => row.name);
  let after = 0;
  const ids = [],
    sizes = [];
  for (;;) {
    const page = fixture.query(
      compositionVerificationQuery({ kind: "composition-page", table: "reconciliation_checkpoints", after, columns }),
    );
    if (!page.length) break;
    sizes.push(page.length);
    assert.ok(
      page.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0) <= maximumSnapshotPageBytes,
    );
    ids.push(...page.map((row) => row.snapshot_rowid));
    after = page.at(-1).snapshot_rowid;
  }
  assert.deepEqual(sizes, [3, 2]);
  assert.deepEqual(ids, [1, 3, 5, 8, 11]);
});
