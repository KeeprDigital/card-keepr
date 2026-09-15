import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  cloudflareD1BackupProvider,
  createVerifiedCatalogueBackup,
  type D1BackupProvider,
} from "../../../src/catalogue/backup-recovery";
import { createEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { retainEvidenceObjectReferenceStatement } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { compositionVerificationStatement } from "../../../src/catalogue/backup-recovery/composition-verification-repository";
import {
  captureParentContextArtifacts,
  verifyParentContextArtifacts,
} from "../../../src/catalogue/backup-recovery/composition-parent-context-artifacts";
import type { CompositionQuery } from "../../../src/catalogue/backup-recovery/composition-verification";
import { collect, get, requiredString } from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { installRuntimeSuite, clearActiveRunForNextScenario, showCollection } from "./runtime-helpers";
import { injectFixtureEvidencePlan, collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { seedRunFixtureStatement } from "./query-helpers/run-events";
import {
  parentContextProposalEvidence,
  restoredParentContextFault,
  dropRestoredParentContextTrigger,
  parentContextArtifactPlan,
  parentSnapshotReceiptTrigger,
  dropParentSnapshotReceiptTrigger,
  corruptParentSnapshotReceipt,
} from "./query-helpers/source-parent-context";
import { adapterVersion, parse, retain } from "./source-parent-context-fixture";

installRuntimeSuite();

test("a parent pin retains its direct siblings without retaining or requiring its unreferenced descendants", async () => {
  const run = "parent-context-literal-owner";
  const database = catalogueStore(env.CATALOGUE_DB);
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:04:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  const rootSet = await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  await retainEvidenceObjectReferenceStatement(database, {
    objectKey: rootSet.content_object_key,
    ownerKind: "fixture_parent_observation_decision",
    ownerId: run,
    createdAt: "2026-09-15T03:00:00.000Z",
  }).run();
  const query: CompositionQuery = async (input) =>
    (await compositionVerificationStatement(database, input).all<Record<string, unknown>>()).results;
  const expected = await captureParentContextArtifacts(query);
  expect(expected).toMatchObject({ objects: 0, bytes: 0 });
  await expect(verifyParentContextArtifacts(query, undefined, expected)).resolves.toBeUndefined();
  const at = "2026-10-16T00:00:00.000Z";
  let cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
  for (let unit = 0; cleanup.state !== "completed" && unit < 20; unit++)
    cleanup = await advanceEvidenceCleanup(database, env.EVIDENCE_OBJECTS, cleanup.id, at);
  expect(cleanup).toMatchObject({ state: "completed", protected_objects: 2, deleted_objects: 2 });
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${root}`)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(rootSet.content_object_key)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${child}`)).toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(childSet.content_object_key)).toBeNull();
  expect(await captureParentContextArtifacts(query)).toEqual(expected);
});

async function publishedParentContext(run: string) {
  const database = catalogueStore(env.CATALOGUE_DB);
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:04:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  const rootSet = await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  const unused = await retain(run, 2, '{"unused":true}');
  await parse(unused);
  const unusedChild = await retain(run, 3, '{"also_unused":true}', unused);
  await parse(unusedChild);
  const childObservation = (await readSourceObservation(database, childSet.id, 0)) as { id: string };
  const proposal = await createEntityProposal(
    database,
    {
      game: "pokemon",
      source_lineage: "tcgdex-pokemon-en",
      reference: run,
      content: { unresolved: "physical issuance" },
      evidence: { source_snapshot_id: child },
      idempotency_key: run,
    },
    "2026-09-15T03:00:00.000Z",
  );
  await parentContextProposalEvidence(env.CATALOGUE_DB).bind(proposal.id, run, child, childObservation.id).run();
  const at = "2026-10-16T00:00:00.000Z";
  let cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
  for (let unit = 0; cleanup.state !== "completed" && unit < 20; unit++)
    cleanup = await advanceEvidenceCleanup(database, env.EVIDENCE_OBJECTS, cleanup.id, at);
  expect(cleanup).toMatchObject({ state: "completed", protected_objects: 4, deleted_objects: 4 });
  // This existing synthetic One Piece publication exercises actual backup/restore.
  // The separate terminal Pokémon fixture has only an unresolved proposal.
  const source = await collect("/reconciliation/repeatable", `${run}-source`);
  const candidate = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", `${run}-candidate`);
  const published = await approveNativeCandidate(candidate, `${run}-publication`);
  return { database, root, rootSet, published, revision: requiredString(published.document, "resulting_revision_id") };
}

test("actual SQL restore fingerprints the parent bindings and verifies retained ancestors after unused graph cleanup", async () => {
  const { published } = await publishedParentContext("parent-context-backup-exact");
  const attempt = requiredString(published.document, "backup_attempt_id");
  const backup = (await get(`/v1/backups/${attempt}`)).document;
  expect(backup.state).toBe("verified");
  const object = await env.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshot = await env.BACKUPS.get(object!.customMetadata!.snapshot_key!);
  const evidence = await snapshot!.json<Record<string, unknown>>();
  expect(evidence.parent_context_evidence).toMatchObject({
    objects: 2,
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(evidence.tables).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: "source_parse_contexts", rows: 4 }),
      expect.objectContaining({ table: "source_parse_dependencies", rows: 2 }),
    ]),
  );
  const plan = (await parentContextArtifactPlan(env.CATALOGUE_DB).all<{ detail: string }>()).results.map(
    (row) => row.detail,
  );
  expect(plan).toContain(
    "SEARCH dependency USING COVERING INDEX source_parse_dependencies_parent (parent_source_snapshot_id=?)",
  );
  expect(plan.some((detail) => /^SCAN (source_snapshots|source_parse_operations) /u.test(detail))).toBe(false);
});

function verifyParentBackup(
  context: Awaited<ReturnType<typeof publishedParentContext>>,
  id: string,
  provider: D1BackupProvider,
) {
  return createVerifiedCatalogueBackup(
    context.database,
    env.BACKUPS,
    {
      expectedCurrentRevisionId: context.revision,
      idempotencyKey: id,
      observedAt: new Date().toISOString(),
      cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: env.CATALOGUE_D1_DATABASE_ID,
      disposableDatabaseId: env.DISPOSABLE_D1_DATABASE_ID,
      exportToken: env.D1_EXPORT_TOKEN,
      verificationToken: env.D1_VERIFICATION_TOKEN,
    },
    provider,
    {
      publicationArtifacts: env.CATALOGUE_EXPORTS,
      printingImages: env.PRINTING_IMAGES,
      sourceEvidenceObjects: env.EVIDENCE_OBJECTS,
    },
  );
}

test.each([
  ["raw", "missing"],
  ["raw", "corrupt"],
  ["observations", "missing"],
  ["observations", "corrupt"],
] as const)("actual restored backup rejects parent %s bytes that become %s after SQL import", async (kind, failure) => {
  const key = `parent-restored-${kind}-${failure}`;
  const context = await publishedParentContext(key);
  const objectKey = kind === "raw" ? `source-snapshots/${context.root}` : context.rootSet.content_object_key;
  let imported = false;
  const provider: D1BackupProvider = {
    ...cloudflareD1BackupProvider,
    async restoreSql(input) {
      await cloudflareD1BackupProvider.restoreSql(input);
      imported = true;
      if (failure === "missing") await env.EVIDENCE_OBJECTS.delete(objectKey);
      else {
        const object = await env.EVIDENCE_OBJECTS.get(objectKey);
        if (!object) throw new Error("Parent artifact missing before corruption fixture.");
        const bytes = new Uint8Array(await object.arrayBuffer());
        bytes[0]! ^= 1;
        await env.EVIDENCE_OBJECTS.put(objectKey, bytes, {
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
        });
      }
    },
  };
  await expect(verifyParentBackup(context, `${key}-manual`, provider)).rejects.toThrow(
    failure === "missing"
      ? "Required parent evidence is missing"
      : "Required parent evidence failed digest verification",
  );
  expect(imported).toBe(true);
  expect((await get(`/v1/backups/${key}-manual`)).document.state).toBe("failed");
});

test("a restored backup requiring parent evidence rejects a provider call without the evidence bucket", async () => {
  const key = "parent-restored-required-bucket";
  const context = await publishedParentContext(key);
  const provider: D1BackupProvider = {
    ...cloudflareD1BackupProvider,
    reconstructAndVerify({ sourceEvidenceObjects: _omitted, ...input }) {
      return cloudflareD1BackupProvider.reconstructAndVerify(input);
    },
  };
  await expect(verifyParentBackup(context, `${key}-manual`, provider)).rejects.toThrow(
    "Source evidence storage is required to verify parent context",
  );
  expect((await get(`/v1/backups/${key}-manual`)).document.state).toBe("failed");
});

test.each(["context", "dependency"] as const)(
  "actual restored %s row corruption fails its fingerprint with the original schema and physical evidence",
  async (kind) => {
    const key = `parent-restored-${kind}-sql`;
    const context = await publishedParentContext(key);
    let mutated = false;
    const provider: D1BackupProvider = {
      ...cloudflareD1BackupProvider,
      async restoreSql(input) {
        await cloudflareD1BackupProvider.restoreSql(input);
        const query = async (body: { sql: string; params: string[] }) => {
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/d1/database/${input.databaseId}/query`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          const result = await response.json<{ success: boolean; result: { results: Record<string, unknown>[] }[] }>();
          if (!response.ok || !result.success) throw new Error("Restored parent fixture query failed.");
          return result.result[0]!.results;
        };
        // Corrupt only rows in the isolated SQL import. Restore the exact trigger
        // definitions so a schema mismatch cannot substitute for row fingerprints.
        const fault = restoredParentContextFault(kind, `${key}-1`, `${key}-2`);
        const triggers = await query(fault.triggers);
        expect(triggers.length).toBeGreaterThan(0);
        for (const trigger of triggers) await query(dropRestoredParentContextTrigger(String(trigger.name)));
        await query(fault.mutate);
        for (const trigger of triggers) await query({ sql: String(trigger.sql), params: [] });
        expect(await query(fault.triggers)).toEqual(triggers);
        expect(await query(fault.foreignKeys)).toEqual([]);
        mutated = true;
      },
    };
    await expect(verifyParentBackup(context, `${key}-manual`, provider)).rejects.toThrow(
      "Restored composition snapshot differs",
    );
    expect(mutated).toBe(true);
    expect((await get(`/v1/backups/${key}-manual`)).document.state).toBe("failed");
  },
);

test("retained parent artifact verification crosses the metadata page boundary without duplicates or skipped bytes", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  // Thirty-three small independent synthetic runs exceed the 64-object page.
  // This measures the paging boundary, not full-source collection throughput.
  for (let index = 0; index < 33; index++) {
    const run = `parent-context-page-${index}`;
    await seedRunFixtureStatement(env.CATALOGUE_DB, {
      id: run,
      state: "failed",
      failure_code: "fixture_collection_incomplete",
      started_at: "2026-09-15T00:00:00.000Z",
      terminal_at: "2026-09-15T00:02:00.000Z",
    }).run();
    const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
    await parse(root);
    const child = await retain(run, 1, '{"id":"tcgp"}', root);
    const childSet = await parse(child);
    await retainEvidenceObjectReferenceStatement(database, {
      objectKey: childSet.content_object_key,
      ownerKind: "parent_page_fixture",
      ownerId: run,
      createdAt: "2026-09-15T03:00:00.000Z",
    }).run();
  }
  const pages: number[] = [];
  const query: CompositionQuery = async (input) => {
    const rows = (await compositionVerificationStatement(database, input).all<Record<string, unknown>>()).results;
    pages.push(rows.length);
    return rows;
  };
  const evidence = await captureParentContextArtifacts(query);
  expect(evidence.objects).toBe(66);
  expect(pages).toEqual([64, 2, 0]);
  await verifyParentContextArtifacts(query, env.EVIDENCE_OBJECTS, evidence);
  expect(pages).toEqual([64, 2, 0, 64, 2, 0]);
  const firstPage = (
    await compositionVerificationStatement(database, {
      kind: "composition-parent-context-artifacts",
      after: "",
    }).all<{ object_key: string; sha256: string; byte_length: number }>()
  ).results;
  // The new parent observation sorts before all raw bodies, so original key63
  // becomes key64. A second contradictory receipt for that key must not spill
  // past LIMIT and disappear when the cursor advances.
  const boundary = firstPage[62]!;
  expect(boundary.object_key.startsWith("source-snapshots/")).toBe(true);
  const run = "parent-context-boundary-duplicate";
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:02:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}', null, boundary.object_key);
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  await retainEvidenceObjectReferenceStatement(database, {
    objectKey: childSet.content_object_key,
    ownerKind: "parent_page_fixture",
    ownerId: run,
    createdAt: "2026-09-15T03:00:00.000Z",
  }).run();
  const trigger = await parentSnapshotReceiptTrigger(env.CATALOGUE_DB).first<{ sql: string }>();
  if (!trigger) throw new Error("Missing immutable source snapshot fixture trigger.");
  for (const kind of ["digest", "length"] as const) {
    const original = kind === "digest" ? boundary.sha256 : boundary.byte_length;
    const corrupt = kind === "digest" ? "b".repeat(64) : boundary.byte_length + 1;
    await env.CATALOGUE_DB.batch([
      dropParentSnapshotReceiptTrigger(env.CATALOGUE_DB),
      corruptParentSnapshotReceipt(env.CATALOGUE_DB, kind).bind(corrupt, root),
      env.CATALOGUE_DB.prepare(trigger.sql),
    ]);
    const page = (
      await compositionVerificationStatement(database, {
        kind: "composition-parent-context-artifacts",
        after: "",
      }).all<{ object_key: string }>()
    ).results;
    expect(page.at(-1)!.object_key).toBe(boundary.object_key);
    await expect(captureParentContextArtifacts(query)).rejects.toThrow(
      "Parent evidence physical object receipts conflict",
    );
    await env.CATALOGUE_DB.batch([
      dropParentSnapshotReceiptTrigger(env.CATALOGUE_DB),
      corruptParentSnapshotReceipt(env.CATALOGUE_DB, kind).bind(original, root),
      env.CATALOGUE_DB.prepare(trigger.sql),
    ]);
  }
});

test("actual two-run HTTP revalidation shares one parent body and remains verifiable through SQL restore", async () => {
  const database = catalogueStore(env.CATALOGUE_DB);
  const rootUrl = "https://source.invalid/revalidation/root";
  const calls: { conditional: string | null; status: number }[] = [];
  const transport = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      if (request.url !== rootUrl) return Response.json({ child: true });
      const conditional = request.headers.get("if-none-match");
      const status = conditional === '"parent-context-root"' ? 304 : 200;
      calls.push({ conditional, status });
      return new Response(status === 200 ? '{"root":true}' : null, {
        status,
        headers: { etag: '"parent-context-root"', "content-type": "application/json" },
      });
    },
  } as unknown as Fetcher;
  const roots = [];
  for (let index = 0; index < 2; index++) {
    const started = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
      supported_game: "pokemon",
      source_lineage: "tcgdex-pokemon-en",
      adapter_version: adapterVersion,
      idempotency_key: `parent-context-304-${index}`,
      requests: [{ id: "root", url: rootUrl, headers: { accept: "application/json" } }],
    });
    const runId = String(started.id);
    await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, transport, runId);
    const collection = await showCollection(runId);
    expect(collection.state).toBe("parsing");
    const root = collection.snapshots.find((snapshot) => snapshot.request.url === rootUrl)!;
    const child = collection.snapshots.find((snapshot) => snapshot.request.url !== rootUrl)!;
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    roots.push(root);
    const childSet = collection.observation_sets.find((set) => set.source_snapshot_id === child.id)!;
    await retainEvidenceObjectReferenceStatement(database, {
      objectKey: childSet.object_key,
      ownerKind: "parent_304_fixture",
      ownerId: runId,
      createdAt: new Date().toISOString(),
    }).run();
    await clearActiveRunForNextScenario();
  }
  expect(calls).toEqual([
    { conditional: null, status: 200 },
    { conditional: '"parent-context-root"', status: 304 },
  ]);
  expect(roots[1]).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: roots[0]!.id,
    content: { object_key: roots[0]!.content.object_key, digest: roots[0]!.content.digest },
  });
  expect(roots[1]!.id).not.toBe(roots[0]!.id);
  const source = await collect("/reconciliation/repeatable", "parent-context-304-publication-source");
  const candidate = await prepareNativeCandidate(
    source.id,
    "one-piece",
    "catrev_spine_000",
    "parent-context-304-candidate",
  );
  const published = await approveNativeCandidate(candidate, "parent-context-304-publication");
  const attempt = requiredString(published.document, "backup_attempt_id");
  const backup = (await get(`/v1/backups/${attempt}`)).document;
  const object = await env.BACKUPS.head(requiredString(backup, "object_key"));
  const snapshot = await env.BACKUPS.get(object!.customMetadata!.snapshot_key!);
  const evidence = await snapshot!.json<Record<string, unknown>>();
  // One physical raw body, two distinct finalized parent observation manifests.
  expect(evidence.parent_context_evidence).toMatchObject({ objects: 3 });
});
