import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { finalizedObservationSetStatement } from "../../../src/catalogue/source-evidence/source-parse-repository";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { decodeArchiveBatch } from "../../../src/catalogue/source-evidence/source-archive-decode";
import { sourceParseAuthorityGuard } from "../../../src/catalogue/source-evidence/source-parse-authority-repository";
import {
  beginEvidenceCleanup,
  advanceEvidenceCleanup,
  type Cleanup,
} from "../../../src/catalogue/source-evidence/evidence-cleanup";
import {
  claimCleanupObject,
  retainEvidenceObjectReferenceStatement,
  beginEvidenceObjectWrite,
} from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { captureCompositionSourceArtifacts } from "../../../src/catalogue/backup-recovery/composition-source-artifacts";
import { compositionVerificationStatement } from "../../../src/catalogue/backup-recovery/composition-verification-repository";
import { setIngestionRunsStateTerminalAtForTerminalEvidenceDiagnosticsExposeCollectionRetryGuidanceWithoutStale as failRun } from "./query-helpers/source-evidence";
import {
  archiveBlockReceipts,
  archiveObservationCount,
  archiveDecodeReceipt,
  uploadedArchiveObservationInput,
} from "./query-helpers/source-archive";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedArchive, version } from "./source-archive-fixture";

installRuntimeSuite();

async function parsedArchive(key: string) {
  const archive = await seedArchive(key);
  const observations = await parseSnapshotBatch(archive.db, env.EVIDENCE_OBJECTS, archive.snapshot.id, version, {
    intent: "collection",
    idempotencyKey: key,
  });
  if ("kind" in observations) throw new Error("Small archive should be complete.");
  const blocks = await archiveBlockReceipts(archive.db).bind(archive.snapshot.id).all<{ object_key: string }>();
  return { ...archive, observations, block: blocks.results[0]!.object_key };
}

function pin(archive: Awaited<ReturnType<typeof seedArchive>>, objectKey: string) {
  return retainEvidenceObjectReferenceStatement(archive.db, {
    objectKey,
    ownerKind: "archive_cleanup_fixture",
    ownerId: archive.snapshot.id,
    createdAt: new Date().toISOString(),
  });
}

async function terminalCleanup(archive: Awaited<ReturnType<typeof seedArchive>>) {
  const terminal = new Date().toISOString();
  const at = new Date(Date.parse(terminal) + 31 * 86400000).toISOString();
  await failRun(env.CATALOGUE_DB, terminal, archive.run.id).run();
  const cleanup = await beginEvidenceCleanup(archive.db, archive.run.id, archive.snapshot.id, 30, at);
  return { cleanup, at };
}

async function finishCleanup(archive: Awaited<ReturnType<typeof seedArchive>>, cleanup: Cleanup, at: string) {
  for (let unit = 0; unit < 12 && !["completed", "paused"].includes(cleanup.state); unit++)
    cleanup = await advanceEvidenceCleanup(archive.db, env.EVIDENCE_OBJECTS, cleanup.id, at);
  return cleanup;
}

test("a permanent adopted root protects its raw, manifest and decoded block during terminal cleanup", async () => {
  const archive = await parsedArchive("archive-cleanup-protected");
  await pin(archive, archive.observations.content_object_key).run();
  const { cleanup, at } = await terminalCleanup(archive);
  expect(await finishCleanup(archive, cleanup, at)).toMatchObject({
    state: "completed",
    deleted_objects: 0,
    protected_objects: 3,
  });
  for (const key of [archive.snapshot.content_object_key, archive.observations.content_object_key, archive.block])
    expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
});

test("a new root pin cannot resurrect a derived child already reserved for deletion", async () => {
  const archive = await parsedArchive("archive-cleanup-late-pin");
  const { cleanup, at } = await terminalCleanup(archive);
  await claimCleanupObject(archive.db, cleanup.id, archive.block, at).run();
  for (const key of [archive.observations.content_object_key, archive.snapshot.content_object_key])
    await expect(pin(archive, key).run()).rejects.toThrow("evidence_cleanup_reference_fenced");
  expect(await finishCleanup(archive, cleanup, at)).toMatchObject({
    state: "completed",
    deleted_objects: 3,
    protected_objects: 0,
  });
});

test("unsealed archive blocks stay outside adopted backup closure and are reclaimed with their terminal run", async () => {
  const archive = await seedArchive("archive-cleanup-unsealed");
  // One-record blocks, retained a bounded call at a time; stopping at four of
  // the archive's seven leaves the decode unsealed with blocks to reclaim.
  let partial;
  do {
    partial = await decodeArchiveBatch(
      archive.db,
      env.EVIDENCE_OBJECTS,
      archive.snapshot,
      archive.pin,
      () => sourceParseAuthorityGuard(archive.db, archive.run.id, { intent: "collection" }),
      1,
    );
  } while (partial.state === "decoding" && partial.next_block < 4);
  expect(partial).toMatchObject({ state: "decoding", next_block: 4, next_record: 4 });
  expect(await archiveObservationCount(archive.db).bind(archive.snapshot.id).first("count")).toBe(0);
  const closure = await captureCompositionSourceArtifacts(
    async (query) => (await compositionVerificationStatement(archive.db, query).all()).results,
  );
  expect(closure.objects).toBe(0);
  const blocks = await archiveBlockReceipts(archive.db).bind(archive.snapshot.id).all<{ object_key: string }>();
  const { cleanup, at } = await terminalCleanup(archive);
  expect(await finishCleanup(archive, cleanup, at)).toMatchObject({ state: "completed", deleted_objects: 5 });
  for (const key of [archive.snapshot.content_object_key, ...blocks.results.map((row) => row.object_key)])
    expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
  expect((await archiveBlockReceipts(archive.db).bind(archive.snapshot.id).all()).results).toHaveLength(4);
  expect(await archiveDecodeReceipt(archive.db).bind(archive.snapshot.id).first("state")).toBe("decoding");
});

test("an unrelated unacknowledged writer prevents deletion of its exact derived block", async () => {
  const archive = await parsedArchive("archive-cleanup-writer");
  await beginEvidenceObjectWrite(
    archive.db,
    "unrelated-archive-writer",
    archive.run.id,
    archive.block,
    new Date().toISOString(),
  ).run();
  const { cleanup, at } = await terminalCleanup(archive);
  expect(await finishCleanup(archive, cleanup, at)).toMatchObject({
    state: "paused",
    failure_code: "evidence_cleanup_writer_unsettled",
  });
  expect(await env.EVIDENCE_OBJECTS.head(archive.block)).not.toBeNull();
});

test("final observation adoption cannot revive an unadopted block reserved for deletion", async () => {
  const archive = await seedArchive("archive-cleanup-late-adoption");
  let interrupted = false;
  const db = catalogueStore(
    new Proxy(env.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            if (!interrupted && (await uploadedArchiveObservationInput(archive.db).bind(archive.snapshot.id).first())) {
              interrupted = true;
              throw new Error("lost archive upload response");
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
  await expect(
    parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, archive.snapshot.id, version, {
      intent: "collection",
      idempotencyKey: "archive-cleanup-late-adoption",
    }),
  ).rejects.toThrow("lost archive upload response");
  expect(interrupted).toBe(true);
  const uploaded = await uploadedArchiveObservationInput(archive.db)
    .bind(archive.snapshot.id)
    .first<Parameters<typeof finalizedObservationSetStatement>[1]>();
  expect(uploaded).not.toBeNull();
  const blocks = await archiveBlockReceipts(archive.db).bind(archive.snapshot.id).all<{ object_key: string }>();
  const { cleanup, at } = await terminalCleanup(archive);
  await claimCleanupObject(archive.db, cleanup.id, blocks.results[0]!.object_key, at).run();
  await expect(finalizedObservationSetStatement(archive.db, uploaded!).run()).rejects.toThrow(
    "evidence_cleanup_reference_fenced",
  );
  expect(await archiveObservationCount(archive.db).bind(archive.snapshot.id).first("count")).toBe(0);
});
