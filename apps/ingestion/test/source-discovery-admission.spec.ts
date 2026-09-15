import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  appendDiscoveredEvidenceRequests,
  startEvidenceRun,
  requiredEvidenceRun,
  pendingEvidenceRequests,
} from "../../../src/catalogue/source-evidence";
import { sourceParseAuthorityGuard } from "../../../src/catalogue/source-evidence/source-parse-authority-repository";
import { installRuntimeSuite } from "./runtime-helpers";
import { paddingChunk } from "./source-discovery-admission-fixture";
import {
  seedAdmissionPlans,
  seedAdmissionRequests,
  populationFacts,
  proposalRows,
} from "./query-helpers/source-discovery-admission";
import expected from "./fixtures/source-discovery-admission.json";

installRuntimeSuite();

test("an immutable collision in a later discovery chunk rolls back every earlier sibling", async () => {
  const db = catalogueStore(env.CATALOGUE_DB);
  const started = await startEvidenceRun(db, {
    acquisition_budget: fixtureAcquisitionBudget,
    supported_game: "magic",
    source_lineage: "scryfall-magic-en",
    adapter_version: "scryfall-magic-en@1",
    idempotency_key: "source-discovery-cross-chunk-collision",
    requests: [{ id: expected.root.id, url: expected.root.url, headers: expected.root.headers }],
  });
  const run = await requiredEvidenceRun(db, String(started.id));
  const [parent] = await pendingEvidenceRequests(db, run.id);
  expect(parent).toBeDefined();
  const proposal = expected.proposals[0]!;
  const identity = expected.proposal_identities[0]!;
  // Deliberate corrupt identity: all stored plan/request fields agree with each
  // other, but the retained URL differs from this independently known identity.
  const conflicting = JSON.stringify([
    {
      id: identity.id,
      url: expected.proposals[1]!.url,
      headers_json: JSON.stringify(proposal.headers),
      representation_fingerprint: identity.fingerprint,
      sequence_number: 1,
    },
  ]);
  await db.batch([
    sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
    seedAdmissionPlans(db).bind(run.id, parent!.request_id, conflicting),
    seedAdmissionRequests(db, run.id, conflicting, JSON.stringify([identity.id])),
  ]);
  const before = await populationFacts(db).bind(run.id, parent!.request_id).first();
  const retained = (
    await proposalRows(db)
      .bind(run.id, JSON.stringify([identity.id]))
      .all()
  ).results;
  expect(retained).toHaveLength(1);
  const fresh = [...(await paddingChunk(0)), ...(await paddingChunk(64))].slice(0, 100);
  await expect(
    appendDiscoveredEvidenceRequests(
      db,
      run,
      parent!,
      [
        ...fresh.map((row) => ({ role: "image" as const, url: row.url, headers: proposal.headers })),
        { ...proposal, role: "image" as const },
      ],
      () => sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
    ),
  ).rejects.toThrow("Discovered Source Request identity collided with different immutable evidence.");
  expect(await populationFacts(db).bind(run.id, parent!.request_id).first()).toEqual(before);
  expect(
    (
      await proposalRows(db)
        .bind(run.id, JSON.stringify(fresh.map((row) => row.id)))
        .all()
    ).results,
  ).toEqual([]);
  expect(
    (
      await proposalRows(db)
        .bind(run.id, JSON.stringify([identity.id]))
        .all()
    ).results,
  ).toEqual(retained);
});
