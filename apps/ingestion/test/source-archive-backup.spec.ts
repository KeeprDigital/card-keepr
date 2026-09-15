import { expect, test } from "vitest";
import { parseSnapshot, parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import riotPage from "../../../acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json";
import { canonicalJson, catalogueStore, sha256Text } from "../../../src/catalogue/shared";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { cleanupObject } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { seedRunFixtureStatement } from "./query-helpers/run-events";
import * as historicalQueries from "./query-helpers/curated-evidence";
import { insertCuratedRevisions } from "./query-helpers/curated";
import { appendDiscoveredEvidenceRequests, collectSourceRequestBatch } from "../../../src/catalogue/source-evidence";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import {
  captureCompositionSourceArtifacts,
  verifyCompositionSourceArtifacts,
} from "../../../src/catalogue/backup-recovery/composition-source-artifacts";
import {
  compositionVerificationStatement,
  type CompositionQuery,
} from "../../../src/catalogue/backup-recovery/composition-verification-repository";
import type { SnapshotRow } from "../../../src/catalogue/source-evidence/source-evidence-repository-types";
import { retainEvidenceObjectReferenceStatement } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import type { CompositionSnapshotEvidence } from "../../../src/catalogue/backup-recovery/composition-verification";
import {
  cloudflareD1BackupProvider,
  createVerifiedCatalogueBackup,
  type D1BackupProvider,
} from "../../../src/catalogue/backup-recovery";
import { collect, get, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { readNativeCards } from "./native-no-change-helpers";
import {
  archiveBlockReceipts,
  restoredArchiveFaultQueries,
  dropRestoredArchiveTrigger,
  archiveImageSnapshot,
  archiveReplacementFetch,
  archiveReplacementSnapshot,
  archiveMoveSnapshotPointer,
  archiveBoundarySnapshot,
  archiveBoundaryParse,
  archiveBoundaryObservationSet,
} from "./query-helpers/source-archive";
import { seedArchive, version } from "./source-archive-fixture";

installReconciliationSuite();

test("an installed archive schema backs up and restores a legacy catalogue without source storage", async () => {
  const query: CompositionQuery = async (input) =>
    (await compositionVerificationStatement(catalogueStore(testEnv.CATALOGUE_DB), input).all<Record<string, unknown>>())
      .results;
  const expected = await captureCompositionSourceArtifacts(query);
  expect(expected.objects).toBe(0);
  await expect(verifyCompositionSourceArtifacts(query, undefined, expected)).resolves.toBeUndefined();
  const source = await collect("/reconciliation/repeatable", "archive-empty-source");
  const candidate = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "archive-empty-candidate");
  const published = await approveNativeCandidate(candidate, "archive-empty-publication");
  const revision = requiredString(published.document, "resulting_revision_id");
  let imported = false;
  const provider: D1BackupProvider = {
    ...cloudflareD1BackupProvider,
    async restoreSql(input) {
      await cloudflareD1BackupProvider.restoreSql(input);
      imported = true;
    },
  };
  await verifyArchiveBackup(
    { db: catalogueStore(testEnv.CATALOGUE_DB) },
    revision,
    "archive-empty-manual",
    provider,
    false,
  );
  expect(imported).toBe(true);
  expect((await get("/v1/backups/archive-empty-manual")).document.state).toBe("verified");
  expect(await captureCompositionSourceArtifacts(query)).toEqual(expected);
});

async function retainedArchive(key: string, retainImage = false) {
  const archive = await seedArchive(key);
  const observations = await parseSnapshotBatch(archive.db, testEnv.EVIDENCE_OBJECTS, archive.snapshot.id, version, {
    intent: "collection",
    idempotencyKey: key,
  });
  if ("kind" in observations) throw new Error("Small archive should be complete.");
  // A fixed permanent-reference fixture exercises the generic dependency
  // contract. It does not stand in for a Curated Revision or Magic publication.
  await retainEvidenceObjectReferenceStatement(archive.db, {
    objectKey: observations.content_object_key,
    ownerKind: "archive_backup_fixture",
    ownerId: key,
    createdAt: new Date().toISOString(),
  }).run();
  let image: SnapshotRow | null = null;
  if (retainImage) {
    for await (const page of discoveredSourceRecordRequests(archive.db, observations.id)) {
      const first = page[0];
      if (!first) continue;
      const requests = await appendDiscoveredEvidenceRequests(archive.db, archive.run, archive.request, [first]);
      // A small synthetic PNG exercises exact private snapshot ownership. It is
      // not a captured Scryfall scan or a published Printing Image fixture.
      const bytes = Uint8Array.from(
        atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
        (c) => c.charCodeAt(0),
      );
      const captured = await collectSourceRequestBatch({
        database: archive.db,
        evidenceObjects: testEnv.EVIDENCE_OBJECTS,
        officialSourceTransport: {
          fetch: async () => new Response(bytes, { headers: { "content-type": "image/png" } }),
        } as unknown as Fetcher,
        runId: archive.run.id,
        requests,
        hostname: "cards.scryfall.io",
        pacingMode: "immediate",
        pacingIntervalMilliseconds: 0,
      });
      expect(captured).toMatchObject({ processed: 1, halt: null });
      image = await archiveImageSnapshot(archive.db).bind(archive.run.id, requests[0]!.request_id).first<SnapshotRow>();
      expect(image).not.toBeNull();
      await retainEvidenceObjectReferenceStatement(archive.db, {
        objectKey: image!.content_object_key,
        ownerKind: "archive_backup_fixture",
        ownerId: key,
        createdAt: new Date().toISOString(),
      }).run();
      break;
    }
    expect(image).not.toBeNull();
  }
  return { ...archive, observations, image };
}

test.each(["identical", "sha256", "byte_length", "kind"] as const)(
  "archive physical key 64 validates all %s receipts before advancing its page cursor",
  async (conflict) => {
    const archive = await retainedArchive(`archive-page-${conflict}`, true);
    const query: CompositionQuery = async (input) =>
      (await compositionVerificationStatement(archive.db, input).all<Record<string, unknown>>()).results;
    const original = archive.image!;
    const bytes = new Uint8Array(
      await (await testEnv.EVIDENCE_OBJECTS.get(original.content_object_key))!.arrayBuffer(),
    );
    const at = new Date().toISOString();
    const lastKey = "zz-archive-boundary/58";
    // Five real fixture objects plus 59 small retained image captures place the
    // duplicated key exactly at the end of the first 64-key page. These are
    // stored-history integrity fixtures, not 59 live source requests.
    for (let ordinal = 0; ordinal < 59; ordinal++) {
      const id = `archive-page-${ordinal}`;
      const key = `zz-archive-boundary/${String(ordinal).padStart(2, "0")}`;
      await testEnv.EVIDENCE_OBJECTS.put(key, bytes);
      await archive.db.batch([
        archiveReplacementFetch(archive.db).bind(id, at, "success", "{}", original.id),
        archiveBoundarySnapshot(archive.db).bind(id, at, original.content_digest, bytes.length, key, original.id, 200),
        retainEvidenceObjectReferenceStatement(archive.db, {
          objectKey: key,
          ownerKind: "archive_backup_fixture",
          ownerId: id,
          createdAt: at,
        }),
      ]);
    }
    const page = await query({ kind: "composition-source-artifacts", after: "" });
    expect(page).toHaveLength(64);
    expect(page.at(-1)?.object_key).toBe(lastKey);
    const expected = await captureCompositionSourceArtifacts(query);
    expect(expected.objects).toBe(64);
    if (conflict === "kind") {
      await archive.db.batch([
        archiveBoundaryParse(archive.db).bind(
          "archive-conflict",
          original.id,
          lastKey,
          at,
          original.content_digest,
          bytes.length,
          "reparse",
          "finalized",
          0,
        ),
        archiveBoundaryObservationSet(archive.db).bind(
          "archive-conflict",
          original.id,
          at,
          original.content_digest,
          bytes.length,
          lastKey,
          0,
        ),
      ]);
    } else {
      await archive.db.batch([
        archiveReplacementFetch(archive.db).bind("archive-alias", at, "success", "{}", original.id),
        archiveBoundarySnapshot(archive.db).bind(
          "archive-alias",
          at,
          conflict === "sha256" ? "f".repeat(64) : original.content_digest,
          conflict === "byte_length" ? bytes.length + 1 : bytes.length,
          lastKey,
          original.id,
          200,
        ),
      ]);
    }
    if (conflict === "identical") {
      expect(await captureCompositionSourceArtifacts(query)).toEqual(expected);
      await expect(
        verifyCompositionSourceArtifacts(query, testEnv.EVIDENCE_OBJECTS, expected),
      ).resolves.toBeUndefined();
    } else {
      await expect(captureCompositionSourceArtifacts(query)).rejects.toThrow(
        "Source evidence artifact receipt is invalid",
      );
      await expect(verifyCompositionSourceArtifacts(query, testEnv.EVIDENCE_OBJECTS, expected)).rejects.toThrow(
        "Source evidence artifact receipt is invalid",
      );
    }
  },
);

async function publishedArchive(key: string, retainImage = false) {
  const archive = await retainedArchive(key, retainImage);
  // Existing synthetic One Piece publication supplies a complete published
  // catalogue; the dependency under test consists of seven retained Magic rows.
  const source = await collect("/reconciliation/repeatable", `${key}-source`);
  const candidate = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", `${key}-candidate`);
  const published = await approveNativeCandidate(candidate, `${key}-publication`);
  return { archive, published, revision: requiredString(published.document, "resulting_revision_id") };
}

test.each(["parent", "image"] as const)(
  "retained image evidence survives the %s request pointer moving to another capture",
  async (kind) => {
    const archive = await retainedArchive(`archive-pointer-${kind}`, true);
    const query: CompositionQuery = async (input) =>
      (await compositionVerificationStatement(archive.db, input).all<Record<string, unknown>>()).results;
    const before = await captureCompositionSourceArtifacts(query);
    expect(before.objects).toBe(5);
    const original = kind === "parent" ? archive.snapshot : archive.image!;
    const replacement = `replacement-${kind}`,
      key = `source-snapshots/${replacement}`,
      at = new Date().toISOString();
    const bytes = new Uint8Array(
      await (await testEnv.EVIDENCE_OBJECTS.get(original.content_object_key))!.arrayBuffer(),
    );
    await testEnv.EVIDENCE_OBJECTS.put(key, bytes);
    // Schema-valid retained capture history, matching the parent-context fixture:
    // the current pointer changes; acknowledged snapshots and pins stay immutable.
    // Ordinary collection stops at observed requests, so this is a storage/restore
    // compatibility proof, not a claim that collection automatically refetches them.
    await archive.db.batch([
      archiveReplacementFetch(archive.db).bind(replacement, at, "success", "{}", original.id),
      archiveReplacementSnapshot(archive.db).bind(replacement, at, 200, key, null, original.id),
      archiveMoveSnapshotPointer(archive.db).bind(replacement, archive.run.id, original.request_id),
    ]);
    expect(await captureCompositionSourceArtifacts(query)).toEqual(before);
    await testEnv.EVIDENCE_OBJECTS.delete(archive.image!.content_object_key);
    await expect(verifyCompositionSourceArtifacts(query, testEnv.EVIDENCE_OBJECTS, before)).rejects.toThrow(
      "Required source evidence is missing",
    );
  },
);

test("an archive backup preserves a historical nonarchive Curated citation whose source was already deleted", async () => {
  const run = "archive-historical-curated-control";
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const url =
    "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200";
  const page = structuredClone(riotPage);
  page.data = page.data.slice(0, 1);
  page.metadata.totalItems = page.metadata.totalPages = 1;
  page.linkdata.last = page.linkdata.first;
  delete (page.linkdata as { next?: string }).next;
  const raw = JSON.stringify(page),
    rawKey = `source-snapshots/${run}`;
  await seedRunFixtureStatement(testEnv.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture",
    idempotency_key: run,
    started_at: "2026-08-01T00:00:00.000Z",
    terminal_at: "2026-08-01T00:00:00.000Z",
  }).run();
  await testEnv.CATALOGUE_DB.batch([
    historicalQueries.curatedEvidenceRequest(testEnv.CATALOGUE_DB).bind(run, run, url),
    historicalQueries.curatedEvidenceFetch(testEnv.CATALOGUE_DB).bind(run, run, run),
    historicalQueries
      .curatedEvidenceSnapshot(testEnv.CATALOGUE_DB)
      .bind(run, run, run, run, url, await sha256Text(raw), new TextEncoder().encode(raw).byteLength, rawKey),
  ]);
  await testEnv.EVIDENCE_OBJECTS.put(rawKey, raw);
  const set = await parseSnapshot(db, testEnv.EVIDENCE_OBJECTS, run, "riftbound-en@1", {
    intent: "collection",
    idempotencyKey: run,
  });
  let cleanup = await beginEvidenceCleanup(db, run, run, 30, "2026-09-08T00:00:00.000Z");
  for (let unit = 0; unit < 5 && cleanup.state !== "completed"; unit++)
    cleanup = await advanceEvidenceCleanup(db, testEnv.EVIDENCE_OBJECTS, cleanup.id, "2026-09-08T00:00:00.000Z");
  expect(cleanup.state).toBe("completed");
  expect(await testEnv.EVIDENCE_OBJECTS.head(rawKey)).toBeNull();
  const tombstone = await cleanupObject(db, rawKey).first();
  expect(tombstone).toMatchObject({ state: "deleted" });
  // Recreate the historical pre-fix audit state, as actual0037's compatibility
  // fixture does: acknowledgement predates the preserved deletion receipt.
  const id = "currev_archive_historical_control";
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: "historical", path: "/name" },
    assertion: { kind: "field", value: "Historical name" },
    rationale: "The owner retained the inspected historical correction.",
    evidence: [{ kind: "source_observation", id: `srcobs_${set.id.slice("srcobsset_".length)}_1` }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: "0".repeat(64),
    supersedes_revision_id: null,
  };
  await insertCuratedRevisions(testEnv.CATALOGUE_DB)
    .bind(
      id,
      "one-piece|field|card|historical|/name",
      canonicalJson(proposal),
      await sha256Text(canonicalJson(proposal)),
      "0".repeat(64),
      canonicalJson({ catalogue_revision_id: "catrev_spine_000", game_profile: "one-piece@1" }),
      "2026-08-05T01:02:03.000Z",
    )
    .run();
  await historicalQueries.historicalCuratedStatus(testEnv.CATALOGUE_DB).bind("retired", id).run();
  const history = await historicalQueries.historicalCuratedBytes(testEnv.CATALOGUE_DB).bind(id).first();
  const { published } = await publishedArchive("archive-historical-backup");
  const backup = (await get(`/v1/backups/${published.document.backup_attempt_id}`)).document;
  expect(backup.state).toBe("verified");
  expect(await cleanupObject(db, rawKey).first()).toEqual(tombstone);
  expect(await historicalQueries.historicalCuratedBytes(testEnv.CATALOGUE_DB).bind(id).first()).toEqual(history);
  expect(await testEnv.EVIDENCE_OBJECTS.head(rawKey)).toBeNull();
  expect((await get(`/v1/source-snapshots/${run}/content`)).response.status).toBe(410);
  expect((await get(`/v1/curated-revisions/${id}`)).document).toMatchObject({ revision: { content: proposal } });
});

test("actual SQL export and restore verifies an adopted archive's raw, derived and observation dependencies", async () => {
  const { published } = await publishedArchive("archive-backup-exact");
  const attempt = requiredString(published.document, "backup_attempt_id");
  const backup = (await get(`/v1/backups/${attempt}`)).document;
  expect(backup.state).toBe("verified");
  const object = await testEnv.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshot = await testEnv.BACKUPS.get(object!.customMetadata!.snapshot_key!);
  const evidence = await snapshot!.json<CompositionSnapshotEvidence>();
  expect(evidence.source_evidence).toMatchObject({ objects: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  for (const [table, rows] of [
    ["source_archive_decodes", 1],
    ["source_archive_blocks", 1],
    ["source_archive_parse_progress", 1],
    ["source_archive_record_receipts", 7],
  ] as const)
    expect(evidence.tables.find((entry) => entry.table === table)).toMatchObject({ rows });
});

function verifyArchiveBackup(
  archive: Pick<Awaited<ReturnType<typeof retainedArchive>>, "db">,
  revision: string,
  id: string,
  provider: D1BackupProvider,
  includeSourceStorage = true,
) {
  return createVerifiedCatalogueBackup(
    archive.db,
    testEnv.BACKUPS,
    {
      expectedCurrentRevisionId: revision,
      idempotencyKey: id,
      observedAt: new Date().toISOString(),
      cloudflareAccountId: testEnv.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: testEnv.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: testEnv.DISPOSABLE_D1_DATABASE_ID,
      exportToken: testEnv.D1_EXPORT_TOKEN,
      verificationToken: testEnv.D1_VERIFICATION_TOKEN,
    },
    provider,
    {
      publicationArtifacts: testEnv.CATALOGUE_EXPORTS,
      printingImages: testEnv.PRINTING_IMAGES,
      ...(includeSourceStorage ? { sourceEvidenceObjects: testEnv.EVIDENCE_OBJECTS } : {}),
    },
  );
}

test.each([
  ["raw", "missing"],
  ["raw", "corrupt"],
  ["derived", "missing"],
  ["derived", "corrupt"],
  ["observations", "missing"],
  ["observations", "corrupt"],
  ["image", "missing"],
  ["image", "corrupt"],
] as const)("actual restored backup rejects %s source bytes that become %s after SQL import", async (kind, failure) => {
  const key = `archive-restored-${kind}-${failure}`;
  const { archive, revision } = await publishedArchive(key, kind === "image");
  const blocks = await archiveBlockReceipts(archive.db).bind(archive.snapshot.id).all<{ object_key: string }>();
  const objectKey =
    kind === "raw"
      ? archive.snapshot.content_object_key
      : kind === "observations"
        ? archive.observations.content_object_key
        : kind === "image"
          ? archive.image!.content_object_key
          : blocks.results[0]!.object_key;
  let imported = false;
  const provider: D1BackupProvider = {
    ...cloudflareD1BackupProvider,
    async restoreSql(input) {
      await cloudflareD1BackupProvider.restoreSql(input);
      imported = true;
      if (failure === "missing") await testEnv.EVIDENCE_OBJECTS.delete(objectKey);
      else {
        const object = await testEnv.EVIDENCE_OBJECTS.get(objectKey);
        if (!object) throw new Error("Source artifact missing before corruption fixture.");
        const bytes = new Uint8Array(await object.arrayBuffer());
        bytes[0]! ^= 1;
        // Keep length and claimed metadata intact: verification must read bytes.
        await testEnv.EVIDENCE_OBJECTS.put(objectKey, bytes, {
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        });
      }
    },
  };
  const id = `${key}-manual`;
  await expect(verifyArchiveBackup(archive, revision, id, provider)).rejects.toThrow(
    failure === "missing"
      ? "Required source evidence is missing"
      : "Required source evidence failed digest verification",
  );
  expect(imported).toBe(true);
  expect((await get(`/v1/backups/${id}`)).document.state).toBe("failed");
  expect((await readNativeCards(revision)).status).toBe(200);
});

test.each(["block", "record"] as const)(
  "actual restored %s corruption fails the original snapshot fingerprint with intact source objects",
  async (kind) => {
    const key = `archive-restored-${kind}-sql`;
    const { archive, revision } = await publishedArchive(key);
    let mutated = false;
    const provider: D1BackupProvider = {
      ...cloudflareD1BackupProvider,
      async restoreSql(input) {
        await cloudflareD1BackupProvider.restoreSql(input);
        // Queries address the independent database that consumed actual exported
        // SQL. Temporarily remove and exactly restore triggers so the final schema
        // stays identical; the test must detect missing/changed data, not DDL.
        const query = async (body: { sql: string; params: (string | number)[] }) => {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          const result = await response.json<{ success: boolean; result: { results: Record<string, unknown>[] }[] }>();
          if (!response.ok || !result.success) throw new Error("Restored archive fixture query failed.");
          return result.result[0]!.results;
        };
        const fixture = restoredArchiveFaultQueries(
          kind,
          archive.snapshot.id,
          archive.observations.id,
          0,
          "0".repeat(64),
        );
        const triggers = await query(fixture.triggers);
        expect(triggers.length).toBeGreaterThan(0);
        for (const trigger of triggers) await query(dropRestoredArchiveTrigger(String(trigger.name)));
        await query(fixture.mutate);
        for (const trigger of triggers) await query({ sql: String(trigger.sql), params: [] });
        expect(await query(fixture.triggers)).toEqual(triggers);
        expect(await query(fixture.foreignKeys)).toEqual([]);
        mutated = true;
      },
    };
    const id = `${key}-manual`;
    await expect(verifyArchiveBackup(archive, revision, id, provider)).rejects.toThrow(
      "Restored composition snapshot differs",
    );
    expect(mutated).toBe(true);
    expect((await get(`/v1/backups/${id}`)).document.state).toBe("failed");
    expect((await readNativeCards(revision)).status).toBe(200);
  },
);
