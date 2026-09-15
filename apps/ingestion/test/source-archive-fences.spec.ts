import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import * as queries from "./query-helpers/source-archive-fences";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedArchive, version } from "./source-archive-fixture";

installRuntimeSuite();

for (const [fence, code] of [
  ["recovery", "catalogue_recovery_writer_fenced"],
  ["handoff", "fresh_baseline_mutation_fenced"],
  ["restored_abandonment", "restored_collection_abandoned"],
] as const) {
  test(`all four archive tables reject prepared writers under ${fence}`, async () => {
    const archive = await seedArchive(`archive-fence-${fence}`);
    const result = await parseSnapshotBatch(archive.db, env.EVIDENCE_OBJECTS, archive.snapshot.id, version, {
      intent: "collection",
      idempotencyKey: fence,
    });
    expect(result).toHaveProperty("observation_count", 11);
    const reads = queries.archiveFenceRows(archive.db);
    const before = await Promise.all(reads.map(async (statement) => (await statement.all()).results));
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 7]);
    const probes = queries.archiveFenceProbes(archive.db);
    for (const probe of probes) {
      await probe.insert.run();
      if (probe.table === "record_receipts")
        await expect(probe.update.run()).rejects.toThrow("immutable_archive_record_receipt");
      else await probe.update.run();
      await expect(probe.remove.run()).rejects.toThrow("immutable_archive_audit");
    }
    if (fence === "recovery") await queries.archiveRecoveryFence(archive.db).run();
    else if (fence === "handoff") {
      const claim = await queries.archiveHandoffClaimTrigger(archive.db).first<string>("sql");
      if (!claim) throw new Error("Handoff claim trigger missing");
      await queries.removeArchiveHandoffClaimTrigger(archive.db).run();
      try {
        await queries
          .archiveHandoffFence(archive.db)
          .bind(
            "archive-handoff",
            "source",
            "archive-dispatch",
            "archive-execution",
            "{}",
            "{}",
            1,
            "[]",
            "2026-09-15T00:00:00.000Z",
          )
          .run();
      } finally {
        await env.CATALOGUE_DB.prepare(claim).run();
      }
      expect(await queries.archiveHandoffClaimTrigger(archive.db).first("sql")).toBe(claim);
    } else {
      await archive.db.batch([
        queries
          .archiveRestoredBackup(archive.db)
          .bind(
            "archive-recovery-backup",
            "{}",
            "archive-owner",
            "catrev_spine_000",
            "pending",
            "archive-backup",
            "2026-09-15T00:00:00.000Z",
          ),
        queries
          .archiveRestoredRecovery(archive.db)
          .bind(
            "archive-recovery",
            "preparing",
            "time_travel",
            "{}",
            "archive-recovery",
            "catrev_spine_000",
            "bookmark",
            "a".repeat(64),
            "archive-recovery-backup",
            "catrev_spine_000",
            "fixture-database",
            38,
            "{}",
            "2026-09-15T00:00:00.000Z",
          ),
        queries
          .archiveRestoredClassification(archive.db)
          .bind("archive-recovery", archive.run.id, "collecting", "abandoned_after_restore"),
      ]);
    }
    for (const probe of probes) {
      await expect(probe.insert.run(), `${probe.table} insert`).rejects.toThrow(code);
      // Receipts and all audit deletes are unconditionally immutable. Either
      // that stronger guard or the state fence must reject the prepared write.
      await expect(probe.update.run(), `${probe.table} update`).rejects.toThrow(
        probe.table === "record_receipts" ? new RegExp(`${code}|immutable_archive_record_receipt`, "u") : code,
      );
      await expect(probe.remove.run(), `${probe.table} delete`).rejects.toThrow(
        new RegExp(`${code}|immutable_archive_audit`, "u"),
      );
    }
    expect(await Promise.all(reads.map(async (statement) => (await statement.all()).results))).toEqual(before);
  });
}
