import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeRecoveryCloudflare } from "./helpers/native-recovery-cloudflare.mjs";
import {
  createExportEvidence,
  insertExportEvidence,
  countExportEvidence,
  exportEvidenceById,
} from "./helpers/query-helpers/sql-export-fixture.mjs";

test("restarted checkpoint transport allocates a fresh import without overwriting verified state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-checkpoint-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const create = () =>
    new Request("https://api.cloudflare.com/client/v4/accounts/local/d1/database", { method: "POST" });
  const before = nativeRecoveryCloudflare({ directory, databaseDirectory: directory });
  const first = await (await before.fetch(create())).json();
  createExportEvidence(before.target).run();
  insertExportEvidence(before.target).run(1, "verified original");
  before.close();
  const gap = new DatabaseSync(join(directory, "restore-4.sqlite"));
  createExportEvidence(gap).run();
  insertExportEvidence(gap).run(1, "retained gap");
  gap.close();
  const concurrent = nativeRecoveryCloudflare({ directory, databaseDirectory: directory });
  const after = nativeRecoveryCloudflare({ directory, databaseDirectory: directory });
  try {
    const [secondResponse, thirdResponse] = await Promise.all([after.fetch(create()), concurrent.fetch(create())]);
    const second = await secondResponse.json(),
      third = await thirdResponse.json();
    assert.deepEqual(
      [second.result.uuid, third.result.uuid].sort(),
      [5, 6].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`),
    );
    assert.notEqual(second.result.uuid, first.result.uuid);
    assert.throws(() => countExportEvidence(after.target).get(), /no such table/);
    const retained = new DatabaseSync(join(directory, "restore-1.sqlite"), { readOnly: true });
    try {
      assert.equal(exportEvidenceById(retained).get(1).body, "verified original");
    } finally {
      retained.close();
    }
    const retainedGap = new DatabaseSync(join(directory, "restore-4.sqlite"), { readOnly: true });
    try {
      assert.equal(exportEvidenceById(retainedGap).get(1).body, "retained gap");
    } finally {
      retainedGap.close();
    }
  } finally {
    concurrent.close();
    after.close();
  }
});
