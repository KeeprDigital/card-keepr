import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import { admitSyntheticCurrentCheckpoint, publicationStateSnapshot } from "./query-helpers/atomic-publication";
import { catalogueStore, type CataloguePrinting } from "../../../src/catalogue/shared";
import { ReconciliationReducerIndex } from "../../../src/catalogue/reconciliation/reconciliation-reducer-state";
import { nativePrintingsAtLocator } from "../../../src/catalogue/reconciliation/native-printing-locators";

installReconciliationSuite();

async function prepare(runId: string, revision: string, state = "sealed") {
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: revision,
    idempotency_key: `native-errata-${runId}`,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  return (await waitForNativeCandidates(runId, 1, 8000, { "one-piece": state }))[0]!;
}

async function publish(candidate: Record<string, unknown>) {
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  let prepared = (
    await post(path, {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: `private-${candidate.id}`,
    })
  ).document;
  for (let unit = 0; prepared.state === "preparing" && unit < 250; unit++)
    prepared = (
      await post(path, {
        manifest_digest: candidate.manifest_digest,
        generation: 0,
        sequence: prepared.sequence,
        idempotency_key: `private-${candidate.id}-${unit}`,
      })
    ).document;
  expect(prepared.state).toBe("verified");
  const approved = (
    await post("/v1/publications", {
      candidate_id: candidate.id,
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      expected_game_revision_id: candidate.expected_game_revision_id,
      idempotency_key: `approve-${candidate.id}`,
    })
  ).document;
  let exported: Record<string, unknown> = { state: "preparing" };
  for (let unit = 0; exported.state === "preparing" && unit < 250; unit++)
    exported = (
      await post(`/v1/publications/${approved.id}/export-preparation/advance`, {
        generation: 0,
        idempotency_key: `public-${candidate.id}-${unit}`,
      })
    ).document;
  expect(exported.state, JSON.stringify(exported)).toBe("verified");
  const published = (await post(`/v1/publications/${approved.id}/advance`, { generation: 0 })).document;
  expect(published.state, JSON.stringify(published)).toBe("published");
  // Controlled unit fixture only: real independent checkpoint proof is in acceptance.
  await admitSyntheticCurrentCheckpoint(testEnv.CATALOGUE_DB);
  return String(published.resulting_revision_id);
}

test.each(["ambiguous", "missing"])("native Errata fails closed for a %s published Printing locator", async (kind) => {
  const seed = await collect("/reconciliation/multi-printing-shared-locator", `native-${kind}-seed`);
  const candidate = await prepare(seed.id, "catrev_spine_000");
  const records = await nativeCandidateRecords(String(candidate.id));
  const ids = records.printings!.map((printing) => printing.id).sort();
  expect(ids).toHaveLength(2);
  const revision = await publish(candidate);
  const before = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
  const source = await collect(`/reconciliation/dedicated-printing-erratum-${kind}`, `native-${kind}-erratum`, {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-official-errata-json@1",
  });
  const failed = await prepare(source.id, revision, "failed");
  const diagnostics = await nativeCandidateRecords(String(failed.id));
  expect(diagnostics.shared_warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "retained_evidence_invalid",
        locator: `/official/multi/${kind === "ambiguous" ? "shared" : "missing"}`,
        matched_printing_ids: kind === "ambiguous" ? ids : [],
        detail: expect.stringContaining("exactly one Printing"),
      }),
    ]),
  );
  expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(before);
  expect((await get(`/v1/game-candidates/${failed.id}`)).document.failure_code).toBe("printing_reconciliation_blocked");
  if (kind === "ambiguous") {
    // Controlled oversized-envelope injection, not source or recovery evidence.
    // Two matches stay below the row cap but exceed the per-unit byte budget.
    const prior = new ReconciliationReducerIndex<CataloguePrinting>(
      catalogueStore(testEnv.CATALOGUE_DB),
      String(failed.id),
      "prior_printings",
      (printing) => printing.card_id,
    );
    prior.resumeAt(1000);
    for (const record of records.printings!) {
      const printing = structuredClone(record) as CataloguePrinting;
      printing.game_data = {
        profile: "one-piece@1",
        attributes: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`padding_${i}`, "x".repeat(24000)])),
      };
      await prior.seed(printing.id, printing);
    }
    let envelopeReads = 0;
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, field) {
        if (field === "prepare")
          return (sql: string) => {
            if (sql.includes("SELECT content, sha256 FROM reconciliation_reducer_state")) envelopeReads++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, field);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      nativePrintingsAtLocator(
        catalogueStore(database),
        {
          preparationId: String(failed.id),
          revision,
          game: "one-piece",
          cardId: String(records.printings![0]!.card_id),
          through: prior.position,
        },
        "one-piece-en",
        "/official/multi/shared",
      ),
    ).rejects.toThrow("reconciliation_capacity_exceeded");
    expect(envelopeReads).toBe(0);
  }
});

test("native Errata resolves an older published locator after a Printing refresh", async () => {
  const seed = await collect("/reconciliation/dedicated-printing-erratum-seed", "native-locator-history-seed");
  const initial = await prepare(seed.id, "catrev_spine_000");
  const initialRecords = await nativeCandidateRecords(String(initial.id));
  const target = initialRecords.printings!.find((p) =>
    (p.locator_evidence as { locator: string }[]).some((e) => e.locator === "/official/dedicated-multi/base"),
  )!;
  expect(target).toBeDefined();
  const firstRevision = await publish(initial);
  const refresh = await collect(
    "/reconciliation/dedicated-printing-erratum-relocated",
    "native-locator-history-refresh",
  );
  const refreshed = await prepare(refresh.id, firstRevision);
  const refreshedRecords = await nativeCandidateRecords(String(refreshed.id));
  const retained = refreshedRecords.printings!.find((p) => p.id === target.id)!;
  expect((retained.locator_evidence as { locator: string }[]).map((e) => e.locator).sort()).toEqual([
    "/official/dedicated-multi/base",
    "/official/dedicated-multi/base-refreshed",
  ]);
  const revision = await publish(refreshed);
  const source = await collect("/reconciliation/dedicated-printing-erratum", "native-locator-history-erratum", {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-official-errata-json@1",
  });
  const corrected = await prepare(source.id, revision);
  const corrections = await nativeCandidateRecords(String(corrected.id));
  expect(corrections.errata).toEqual(
    expect.arrayContaining([expect.objectContaining({ target_type: "printing", target_id: target.id })]),
  );
  expect(await nativeCandidateRecords(String(initial.id))).toEqual(initialRecords);
});
