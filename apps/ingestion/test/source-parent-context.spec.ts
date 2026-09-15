import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore, sha256, utf8 } from "../../../src/catalogue/shared";
import { parseSnapshot } from "../../../src/catalogue/source-evidence/source-evidence-parsing";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { createEntityProposal, inspectEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { insertProposalStatement } from "../../../src/catalogue/reconciliation/entity-admission-repository";
import { identityReviewStatement } from "../../../src/catalogue/reconciliation/canonical-identity-repository";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import {
  claimCleanupObject,
  retainEvidenceObjectReferenceStatement,
} from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { adapterVersion, parse, retain } from "./source-parent-context-fixture";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedRunFixtureStatement } from "./query-helpers/run-events";
import { setOperationStateRecoveryRestoreGuard } from "./query-helpers/ingestion";
import {
  parentContextAttachSnapshot,
  parentContextFetch,
  parentContextSnapshot,
  parentContextProposalEvidence,
  parentContextBindingCounts,
  parentContextPlannedParse,
  parentContextIdentityReview,
  parentContextIdentityReviewRun,
} from "./query-helpers/source-parent-context";

installRuntimeSuite();

test("a discovered response retains its exact parent bytes and actual capture date on replay", async () => {
  const run = "retained-parent-context";
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const first = await parse(child);
  const observation = await readSourceObservation(catalogueStore(env.CATALOGUE_DB), first.id, 0);
  expect(observation).toMatchObject({
    value: {
      parent_evidence: [
        {
          request_id: root,
          snapshot_id: root,
          retrieved_at: "2026-09-15T00:00:00.000Z",
          url: "https://source.invalid/0",
          sha256: "99743122cd79c84f807ea88b06947274da458404e5e645601acf57a9076e26a0",
          text: '{"sets":["tk-ex-latia"]}',
        },
      ],
    },
  });
  expect(await parse(child)).toEqual(first);
});

test("a discovered response rejects ambiguous parent captures instead of selecting the newer interpretation", async () => {
  const run = "ambiguous-parent-context";
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const newer = `${run}-newer`;
  const bytes = utf8('{"sets":["base1"]}');
  const at = "2026-09-15T01:00:00.000Z";
  await env.CATALOGUE_DB.batch([
    parentContextFetch(env.CATALOGUE_DB).bind(newer, run, root, 2, at, at),
    parentContextSnapshot(env.CATALOGUE_DB).bind(
      newer,
      run,
      root,
      newer,
      "https://source.invalid/0",
      at,
      await sha256(bytes),
      bytes.length,
      `source-snapshots/${newer}`,
    ),
    parentContextAttachSnapshot(env.CATALOGUE_DB).bind(newer, run, root),
  ]);
  await env.EVIDENCE_OBJECTS.put(`source-snapshots/${newer}`, bytes);
  await parse(newer);
  await expect(parse(child)).rejects.toMatchObject({ code: "source_parse_failed" });
});

test("interrupted child storage resumes from its pinned parent despite later parent captures and interpretations", async () => {
  const run = "interrupted-parent-context";
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  let interrupted = false;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, key) {
      if (key === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await target.put(...args);
          if (!interrupted) {
            interrupted = true;
            throw new Error("lost child observation upload acknowledgement");
          }
          return result;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    parseSnapshot(catalogueStore(env.CATALOGUE_DB), bucket, child, adapterVersion, {
      intent: "collection",
      idempotencyKey: child,
    }),
  ).rejects.toThrow("lost child observation upload acknowledgement");
  expect(interrupted).toBe(true);
  await parseSnapshot(catalogueStore(env.CATALOGUE_DB), env.EVIDENCE_OBJECTS, root, adapterVersion, {
    intent: "reparse",
    idempotencyKey: "later-interpretation",
  });
  const newer = `${run}-newer`;
  const bytes = utf8('{"sets":["base1"]}');
  const at = "2026-09-15T01:00:00.000Z";
  await env.CATALOGUE_DB.batch([
    parentContextFetch(env.CATALOGUE_DB).bind(newer, run, root, 2, at, at),
    parentContextSnapshot(env.CATALOGUE_DB).bind(
      newer,
      run,
      root,
      newer,
      "https://source.invalid/0",
      at,
      await sha256(bytes),
      bytes.length,
      `source-snapshots/${newer}`,
    ),
    parentContextAttachSnapshot(env.CATALOGUE_DB).bind(newer, run, root),
  ]);
  await env.EVIDENCE_OBJECTS.put(`source-snapshots/${newer}`, bytes);
  await parse(newer);
  const result = await parse(child);
  expect(await readSourceObservation(catalogueStore(env.CATALOGUE_DB), result.id, 0)).toMatchObject({
    value: { parent_evidence: [{ snapshot_id: root, text: '{"sets":["tk-ex-latia"]}' }] },
  });
  expect(await parse(child)).toEqual(result);
});

test.each(["missing", "unparsed", "corrupt"] as const)(
  "%s parent evidence cannot produce a child observation",
  async (failure) => {
    const run = `invalid-parent-context-${failure}`;
    await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
    const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
    if (failure !== "unparsed") await parse(root);
    const child = await retain(run, 1, '{"id":"tcgp"}', failure === "missing" ? "absent-parent" : root);
    if (failure === "corrupt") await env.EVIDENCE_OBJECTS.put(`source-snapshots/${root}`, '{"sets":["tk-ex-ERROR"]}');
    await expect(parse(child)).rejects.toThrow(
      failure === "corrupt" ? "digest verification" : "matching retained evidence",
    );
  },
);

test("a retained child proposal protects its exact discovery ancestors while unused terminal evidence is cleaned", async () => {
  const run = "retained-proposal-parent-context";
  const database = catalogueStore(env.CATALOGUE_DB);
  // Synthetic terminal collection with one unresolved proposal, no candidate or publication.
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:03:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  const rootSet = await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  const unused = await retain(run, 2, '{"unused":true}');
  const unusedSet = await parse(unused);
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
  expect(cleanup).toMatchObject({ state: "completed", protected_objects: 4, deleted_objects: 2 });
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${root}`)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(rootSet.content_object_key)).not.toBeNull();
  expect(await readSourceObservation(database, childSet.id, 0)).toEqual(childObservation);
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${unused}`)).toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(unusedSet.content_object_key)).toBeNull();
});

test("an ancestor cleanup claim rolls back the entire new context binding before child facts are exposed", async () => {
  const run = "claimed-parent-context";
  const database = catalogueStore(env.CATALOGUE_DB);
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:03:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const middle = await retain(run, 1, '{"id":"tcgp"}', root);
  await parse(middle);
  const child = await retain(run, 2, '{"id":"tk-ex-latia"}', middle);
  const at = "2026-10-16T00:00:00.000Z";
  const cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
  await claimCleanupObject(database, cleanup.id, `source-snapshots/${root}`, at).run();
  await expect(parse(child)).rejects.toThrow("evidence_cleanup_reference_fenced");
  expect(await parentContextBindingCounts(env.CATALOGUE_DB).bind(child).first()).toEqual({
    contexts: 0,
    dependencies: 0,
  });
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${root}`)).not.toBeNull();
});

test("an exact permanent child observation reference retains its direct siblings and conditional ancestors", async () => {
  const run = "permanent-parent-context";
  const database = catalogueStore(env.CATALOGUE_DB);
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:03:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  const rootSet = await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  await retainEvidenceObjectReferenceStatement(database, {
    objectKey: childSet.content_object_key,
    ownerKind: "fixture_observation_decision",
    ownerId: run,
    createdAt: "2026-09-15T03:00:00.000Z",
  }).run();
  const at = "2026-10-16T00:00:00.000Z";
  let cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
  for (let unit = 0; cleanup.state !== "completed" && unit < 20; unit++)
    cleanup = await advanceEvidenceCleanup(database, env.EVIDENCE_OBJECTS, cleanup.id, at);
  expect(cleanup).toMatchObject({ state: "completed", protected_objects: 4, deleted_objects: 0 });
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${root}`)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(rootSet.content_object_key)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${child}`)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(childSet.content_object_key)).not.toBeNull();
});

test("a late permanent child reference and its owning proposal roll back when an ancestor was already claimed", async () => {
  const run = "claimed-permanent-parent-context";
  const database = catalogueStore(env.CATALOGUE_DB);
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: run,
    state: "failed",
    failure_code: "fixture_collection_incomplete",
    started_at: "2026-09-15T00:00:00.000Z",
    terminal_at: "2026-09-15T00:03:00.000Z",
  }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  const childSet = await parse(child);
  const at = "2026-10-16T00:00:00.000Z";
  const cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
  await claimCleanupObject(database, cleanup.id, `source-snapshots/${root}`, at).run();
  const proposalId = `proposal_${run}`;
  await expect(
    database.batch([
      insertProposalStatement(database, {
        id: proposalId,
        game: "pokemon",
        source_lineage: "tcgdex-pokemon-en",
        reference: run,
        content_json: "{}",
        evidence_json: "{}",
        idempotency_key: run,
        request_json: "{}",
        created_at: at,
      }),
      retainEvidenceObjectReferenceStatement(database, {
        objectKey: childSet.content_object_key,
        ownerKind: "fixture_proposal",
        ownerId: proposalId,
        createdAt: at,
      }),
    ]),
  ).rejects.toThrow("evidence_cleanup_reference_fenced");
  await expect(inspectEntityProposal(database, proposalId)).rejects.toMatchObject({
    code: "entity_proposal_not_found",
  });
});

test("recovery starting before context commit fences the entire dependency transaction", async () => {
  const run = "recovery-parent-context";
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  let recoveryStarted = false;
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!recoveryStarted && (await parentContextPlannedParse(target).bind(child).first())) {
            recoveryStarted = true;
            await setOperationStateRecoveryRestoreGuard(target).run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, child, adapterVersion, {
      intent: "collection",
      idempotencyKey: child,
    }),
  ).rejects.toThrow("catalogue_recovery_writer_fenced");
  expect(recoveryStarted).toBe(true);
  expect(await parentContextBindingCounts(env.CATALOGUE_DB).bind(child).first()).toEqual({
    contexts: 0,
    dependencies: 0,
  });
});

test("a distinct parent capture finalized before context commit rejects and rolls back the stale selection", async () => {
  const run = "racing-parent-capture";
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: run, state: "collecting" }).run();
  const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
  await parse(root);
  const child = await retain(run, 1, '{"id":"tcgp"}', root);
  let replaced = false;
  const database = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!replaced && (await parentContextPlannedParse(target).bind(child).first())) {
            replaced = true;
            const newer = `${run}-newer`;
            const at = "2026-09-15T01:00:00.000Z";
            const bytes = utf8('{"sets":["base1"]}');
            await target.batch([
              parentContextFetch(target).bind(newer, run, root, 2, at, at),
              parentContextSnapshot(target).bind(
                newer,
                run,
                root,
                newer,
                "https://source.invalid/0",
                at,
                await sha256(bytes),
                bytes.length,
                `source-snapshots/${newer}`,
              ),
              parentContextAttachSnapshot(target).bind(newer, run, root),
            ]);
            await env.EVIDENCE_OBJECTS.put(`source-snapshots/${newer}`, bytes);
            await parse(newer);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    parseSnapshot(catalogueStore(database), env.EVIDENCE_OBJECTS, child, adapterVersion, {
      intent: "collection",
      idempotencyKey: child,
    }),
  ).rejects.toThrow("source_parse_context_invalid");
  expect(replaced).toBe(true);
  expect(await parentContextBindingCounts(env.CATALOGUE_DB).bind(child).first()).toEqual({
    contexts: 0,
    dependencies: 0,
  });
});

test.each(["retained", "claimed"] as const)(
  "canonical identity storage respects %s ancestor evidence independently of proposal references",
  async (mode) => {
    const run = `parent-context-identity-${mode}`;
    const database = catalogueStore(env.CATALOGUE_DB);
    await seedRunFixtureStatement(env.CATALOGUE_DB, {
      id: run,
      state: "failed",
      failure_code: "fixture_collection_incomplete",
      started_at: "2026-09-15T00:00:00.000Z",
      terminal_at: "2026-09-15T00:02:00.000Z",
    }).run();
    const root = await retain(run, 0, '{"sets":["tk-ex-latia"]}');
    const rootSet = await parse(root);
    const child = await retain(run, 1, '{"id":"tcgp"}', root);
    const childSet = await parse(child);
    const observation = (await readSourceObservation(database, childSet.id, 0)) as { id: string };
    const at = "2026-10-16T00:00:00.000Z";
    let cleanup = await beginEvidenceCleanup(database, run, run, 30, at);
    if (mode === "claimed") await claimCleanupObject(database, cleanup.id, `source-snapshots/${root}`, at).run();
    // Exercise the canonical storage tables and their atomic reference guards.
    // This fixture does not make a Card/Printing matching or allocation decision.
    const write = env.CATALOGUE_DB.batch([
      parentContextIdentityReview(env.CATALOGUE_DB).bind(run, run, observation.id, child),
      parentContextIdentityReviewRun(env.CATALOGUE_DB).bind(run, run, observation.id, child),
    ]);
    if (mode === "claimed") {
      await expect(write).rejects.toThrow("evidence_cleanup_reference_fenced");
      expect(await identityReviewStatement(database, run).first()).toBeNull();
    } else {
      await write;
      for (let unit = 0; cleanup.state !== "completed" && unit < 20; unit++)
        cleanup = await advanceEvidenceCleanup(database, env.EVIDENCE_OBJECTS, cleanup.id, at);
      expect(cleanup).toMatchObject({ state: "completed", protected_objects: 4, deleted_objects: 0 });
      expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${root}`)).not.toBeNull();
      expect(await env.EVIDENCE_OBJECTS.head(rootSet.content_object_key)).not.toBeNull();
    }
  },
);
