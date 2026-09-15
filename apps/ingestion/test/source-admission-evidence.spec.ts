import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import bloomvine from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/reversible-adventure.json?raw";
import reminder from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/manifest-reminder.json?raw";
import control from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import { catalogueStore, canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { appendDiscoveredEvidenceRequests, collectSourceRequestBatch } from "../../../src/catalogue/source-evidence";
import { parseSnapshotBatch } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { discoveredSourceRecordRequests } from "../../../src/catalogue/source-evidence/source-record-intake";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import {
  parseSourceAdmissionEvidence,
  retainSourceAdmissionEvidence,
} from "../../../src/catalogue/reconciliation/source-admission-evidence";
import { inspectEntityProposal, decideEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { verifiedRetainedPrintingImage } from "../../../src/catalogue/reconciliation/reconciliation-images";
import type { SnapshotRow } from "../../../src/catalogue/source-evidence/source-evidence-repository-types";
import { setIngestionRunsStateTerminalAtForTerminalEvidenceDiagnosticsExposeCollectionRetryGuidanceWithoutStale as failRun } from "./query-helpers/source-evidence";
import * as archiveQueries from "./query-helpers/source-archive";
import * as queries from "./query-helpers/source-admission-evidence";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedArchive, version } from "./source-archive-fixture";

installRuntimeSuite();

test.each([
  { reviewRaw: bloomvine, reason: "logical_parts_unresolved", imageCount: 2 },
  { reviewRaw: reminder, reason: "category_unresolved", imageCount: 1 },
])(
  "archive $reason intake preserves committed progress, evidence and independent finish decisions",
  async ({ reviewRaw, reason, imageCount }) => {
    const { db, run, snapshot, request } = await seedArchive(
      "review-archive-replay",
      false,
      new TextEncoder().encode([reviewRaw, control].map((raw) => (raw.endsWith("\n") ? raw : `${raw}\n`)).join("")),
    );
    let parseLoss = false,
      proposalLoss = false;
    const failing = catalogueStore(
      new Proxy(env.CATALOGUE_DB, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              const result = await target.batch(statements);
              if (!parseLoss && (await archiveQueries.archiveRecordCount(db).first("count")) === 1) {
                parseLoss = true;
                throw new Error("lost review archive record response");
              }
              if (!proposalLoss && (await queries.reviewEvidencePins(db).bind(run.id).all()).results.length === 1) {
                proposalLoss = true;
                throw new Error("lost finish proposal response");
              }
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const intent = { intent: "collection" as const, idempotencyKey: "review-archive-replay" };
    await expect(parseSnapshotBatch(failing, env.EVIDENCE_OBJECTS, snapshot.id, version, intent)).rejects.toThrow(
      "lost review archive record response",
    );
    expect(parseLoss).toBe(true);
    expect(await archiveQueries.archiveObservationCount(db).bind(snapshot.id).first("count")).toBe(0);
    const sealed = await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent);
    if ("kind" in sealed) throw new Error("Two-record archive should seal on replay.");
    expect(sealed.observation_count).toBe(2);
    expect(await parseSnapshotBatch(db, env.EVIDENCE_OBJECTS, snapshot.id, version, intent)).toEqual(sealed);
    const wrapped = (await readSourceObservation(db, sealed.id, 0)) as { id: string; value: unknown };
    const review = parseSourceAdmissionEvidence(wrapped.value, requiredSourceAdapter(version));
    expect(review.source_sidecar.source_record_json).toBe(JSON.stringify(JSON.parse(reviewRaw)));
    expect(await readSourceObservation(db, sealed.id, 1)).toMatchObject({
      value: { card: { name: "Miara, Thorn of the Glade" } },
    });

    expect(review.issues).toEqual([
      {
        code: reason,
        source_paths:
          reason === "category_unresolved" ? ["layout", "type_line"] : ["card_faces.0.layout", "card_faces.1.layout"],
      },
    ]);
    expect(review).not.toHaveProperty("card");
    expect(review).not.toHaveProperty("printing");
    expect(review).not.toHaveProperty("category");

    const discoveries = [];
    for await (const page of discoveredSourceRecordRequests(db, sealed.id)) discoveries.push(...page);
    const imageRequests = await appendDiscoveredEvidenceRequests(db, run, request, discoveries);
    const image = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
      (c) => c.charCodeAt(0),
    );
    const captured = await collectSourceRequestBatch({
      database: db,
      evidenceObjects: env.EVIDENCE_OBJECTS,
      officialSourceTransport: {
        fetch: async () => new Response(image, { headers: { "content-type": "image/png" } }),
      } as unknown as Fetcher,
      runId: run.id,
      requests: imageRequests,
      hostname: "cards.scryfall.io",
      pacingMode: "immediate",
      pacingIntervalMilliseconds: 0,
    });
    expect(captured).toMatchObject({ processed: imageCount + 1, halt: null });
    const snapshots = (await queries.reviewImageSnapshots(db).bind(run.id, "image").all<SnapshotRow>()).results;
    const images = new Map();
    // The existing retention contract pins every independently verified map
    // entry, including the control image absent from this proposal's faces.
    for (const row of snapshots)
      images.set(row.request_url, {
        ...(await verifiedRetainedPrintingImage(env.EVIDENCE_OBJECTS, row)),
        content_object_key: row.content_object_key,
      });
    expect(images.size).toBe(imageCount + 1);
    // Scoped active-operation fixture: the transition under test is proposal intake,
    // not native dispatch or unrelated collection roots. All writes retain real guards.
    const preparation = "review-evidence-preparation",
      at = new Date().toISOString();
    await db.batch([
      queries
        .insertReviewPreparation(db)
        .bind(
          preparation,
          run.id,
          "magic",
          "preparing",
          at,
          new Date(Date.parse(at) + 86400000).toISOString(),
          "{}",
          0,
          0,
          0,
        ),
      queries.insertReviewSlot(db).bind("magic", preparation, run.id),
    ]);
    const source = {
      sourceObservationId: wrapped.id,
      sourceObservationSetId: sealed.id,
      sourceSnapshotId: snapshot.id,
    };
    const allocations = (await queries.reviewAllocations(db).all()).results;
    for (const statement of [
      "INSERT INTO entity_proposals",
      "INSERT INTO entity_proposal_source_evidence",
      "INSERT INTO evidence_object_references",
    ]) {
      let injected = false;
      const unavailable = catalogueStore(
        new Proxy(env.CATALOGUE_DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                if (sql.includes(statement)) {
                  injected = true;
                  throw new Error("synchronous source admission storage failure");
                }
                return target.prepare(sql);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
      await expect(
        retainSourceAdmissionEvidence(unavailable, preparation, review, source, images, at),
      ).rejects.toMatchObject({
        name: "ReconciliationDocumentStorageError",
        cause: { message: "synchronous source admission storage failure" },
      });
      expect(injected).toBe(true);
      expect((await queries.reviewProposals(db).bind("scryfall-magic-en").all()).results).toEqual([]);
      expect((await queries.reviewEvidencePins(db).bind(run.id).all()).results).toEqual([]);
    }
    await expect(retainSourceAdmissionEvidence(failing, preparation, review, source, images, at)).rejects.toMatchObject(
      {
        cause: { message: "lost finish proposal response" },
      },
    );
    expect(proposalLoss).toBe(true);
    const before = (await queries.reviewProposals(db).bind("scryfall-magic-en").all()).results;
    expect(before).toHaveLength(1);
    const resumed = await retainSourceAdmissionEvidence(db, preparation, review, source, images, at);
    expect(resumed.proposalIds).toHaveLength(2);
    const after = (await queries.reviewProposals(db).bind("scryfall-magic-en").all()).results;
    expect(after).toEqual(expect.arrayContaining(before));
    // Exact pre-Pokémon Magic identity and stored JSON contract. Supplying a
    // separately verified image must not add it to physical_images.
    const physicalImages = review.appearance_evidence.images.map((image) => ({
      ...image,
      ...images.get(image.source_url),
    }));
    const evidence = canonicalJson({
      source_snapshot_id: source.sourceSnapshotId,
      source_observation_set_id: source.sourceObservationSetId,
      source_observation_id: source.sourceObservationId,
      issues: review.issues,
      physical_images: physicalImages,
    });
    for (const finish of ["nonfoil", "foil"]) {
      const reference = canonicalJson([review.locator, finish]);
      const content = canonicalJson({ game: "magic", locator: review.locator, finish });
      const id = `proposal_${await sha256Text(canonicalJson(["scryfall-magic-en", reference]))}`;
      expect(after).toContainEqual(
        expect.objectContaining({
          id,
          reference,
          content_json: content,
          evidence_json: evidence,
          idempotency_key: id,
          request_json: canonicalJson([content, evidence]),
        }),
      );
    }

    expect(await retainSourceAdmissionEvidence(db, preparation, review, source, images, at)).toEqual(resumed);
    expect((await queries.reviewProposals(db).bind("scryfall-magic-en").all()).results).toEqual(after);
    expect((await queries.reviewEvidencePins(db).bind(run.id).all()).results).toHaveLength(2);
    expect((await queries.reviewAllocations(db).all()).results).toEqual(allocations);
    for (const id of resumed.proposalIds) {
      expect(await inspectEntityProposal(db, id)).toMatchObject({ status: "unresolved", generation: 0 });
      expect((await queries.reviewPrivateReferences(db).bind("entity_proposal", id).all()).results).toHaveLength(
        imageCount + 1,
      );
    }

    await db.batch([
      queries.abandonReviewPreparation(db).bind("abandoned", preparation),
      queries.releaseReviewSlot(db).bind(preparation),
    ]);
    await expect(retainSourceAdmissionEvidence(db, preparation, review, source, images, at)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("canonical_identity_run_not_active") },
    });
    await failRun(env.CATALOGUE_DB, at, run.id).run();
    await queries.releaseReviewCollection(db).bind(run.id).run();
    const [nonfoil, foil] = resumed.proposalIds;
    expect(
      await decideEntityProposal(
        db,
        nonfoil!,
        {
          action: "reject",
          expected_generation: "0",
          rationale: "Keep this unresolved finish excluded",
          idempotency_key: "review-reject-nonfoil",
        },
        at,
      ),
    ).toMatchObject({ status: "rejected", generation: 1 });
    expect(await inspectEntityProposal(db, foil!)).toMatchObject({ status: "unresolved", generation: 0 });
    // Reconsideration can carry this bounded initial intake through the existing owner interface.
    expect(
      await decideEntityProposal(
        db,
        foil!,
        {
          action: "reconsider",
          expected_generation: "0",
          rationale: "Retain the source references for inspection",
          idempotency_key: "review-reconsider-foil",
        },
        at,
      ),
    ).toMatchObject({ status: "unresolved", generation: 1 });
    const cleanupAt = new Date(Date.parse(at) + 31 * 86400000).toISOString();
    let cleanup = await beginEvidenceCleanup(db, run.id, "review-terminal-cleanup", 30, cleanupAt);
    for (let unit = 0; unit < 12 && cleanup.state !== "completed"; unit++)
      cleanup = await advanceEvidenceCleanup(db, env.EVIDENCE_OBJECTS, cleanup.id, cleanupAt);
    expect(cleanup.state).toBe("completed");
    const blocks = (await archiveQueries.archiveBlockReceipts(db).bind(snapshot.id).all<{ object_key: string }>())
      .results;
    for (const key of [
      snapshot.content_object_key,
      sealed.content_object_key,
      ...blocks.map((block) => block.object_key),
      ...[...images.values()].map((image) => image.content_object_key),
    ])
      expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
    expect((await queries.reviewAllocations(db).all()).results).toEqual(allocations);
  },
);
