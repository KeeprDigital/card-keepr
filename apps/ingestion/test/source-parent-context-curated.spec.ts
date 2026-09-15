import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore, canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import { createCuratedRevision } from "../../../src/catalogue/curated/curated-revisions";
import { readSourceObservation } from "../../../src/catalogue/reconciliation/reconciliation-source-observation";
import { beginEvidenceCleanup, advanceEvidenceCleanup } from "../../../src/catalogue/source-evidence/evidence-cleanup";
import { claimCleanupObject } from "../../../src/catalogue/source-evidence/evidence-cleanup-repository";
import { collect, get, requiredString } from "./reconciliation-helpers";
import { approveNativeCandidate, prepareNativeCandidate } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { verifyNativeBackup } from "./native-no-change-helpers";
import { installRuntimeSuite } from "./runtime-helpers";
import { seedRunFixtureStatement } from "./query-helpers/run-events";
import { parse, retain } from "./source-parent-context-fixture";

installRuntimeSuite();

async function currentCard(key: string) {
  const source = await collect("/reconciliation/repeatable", `${key}-source`);
  const candidate = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", `${key}-candidate`);
  const records = await nativeCandidateRecords(String(candidate.id), ["cards"]);
  const card = (records.cards as { id: string; name: string }[])[0]!;
  const published = await approveNativeCandidate(candidate, `${key}-publication`);
  return { card, revision: requiredString(published.document, "resulting_revision_id") };
}

async function parentCitation(run: string) {
  const current = await currentCard(run);
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
  const database = catalogueStore(env.CATALOGUE_DB);
  const observation = (await readSourceObservation(database, childSet.id, 0)) as { id: string };
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: current.card.id, path: "/name" },
    assertion: { kind: "field", value: "Reviewed name" },
    rationale: "Retained source context fixture.",
    evidence: [{ kind: "source_observation", id: observation.id }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(current.card.name)),
    supersedes_revision_id: null,
  };
  return {
    database,
    root,
    rootSet,
    observation,
    input: {
      environment: "production",
      expected_current_revision_id: current.revision,
      proposal,
      proposal_digest: await sha256Text(canonicalJson(proposal)),
      idempotency_key: run,
    },
  };
}

test("ordinary Curated authorship retains a cited child's ancestors without a candidate or proposal reference", async () => {
  const run = "parent-context-curated";
  const context = await parentCitation(run);
  await createCuratedRevision(context.database, context.input, "2026-09-15T03:00:00.000Z");
  const at = "2026-10-16T00:00:00.000Z";
  let cleanup = await beginEvidenceCleanup(context.database, run, run, 30, at);
  for (let unit = 0; cleanup.state !== "completed" && unit < 20; unit++)
    cleanup = await advanceEvidenceCleanup(context.database, env.EVIDENCE_OBJECTS, cleanup.id, at);
  expect(cleanup).toMatchObject({ state: "completed", protected_objects: 4, deleted_objects: 0 });
  expect(await env.EVIDENCE_OBJECTS.head(`source-snapshots/${context.root}`)).not.toBeNull();
  expect(await env.EVIDENCE_OBJECTS.head(context.rootSet.content_object_key)).not.toBeNull();
});

test("ordinary Curated creation rolls back its receipt when an ancestor is claimed before the owner transaction", async () => {
  const run = "parent-context-curated-race";
  const context = await parentCitation(run);
  let claimed = false;
  const binding = new Proxy(env.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!claimed) {
            claimed = true;
            const at = "2026-10-16T00:00:00.000Z";
            const cleanup = await beginEvidenceCleanup(context.database, run, run, 30, at);
            await claimCleanupObject(context.database, cleanup.id, `source-snapshots/${context.root}`, at).run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    createCuratedRevision(catalogueStore(binding), context.input, "2026-09-15T03:00:00.000Z"),
  ).rejects.toMatchObject({ code: "curated_revision_evidence_unavailable", status: 409 });
  expect(claimed).toBe(true);
  expect((await get("/v1/curated-revisions")).document.items).toEqual([]);
});

test("an actual backup with no parent dependencies remains verifiable without an evidence bucket argument", async () => {
  const key = "parent-context-empty-compatibility";
  const current = await currentCard(key);
  expect(await verifyNativeBackup(`${key}-manual`, current.revision)).toMatchObject({ verified: true });
});
