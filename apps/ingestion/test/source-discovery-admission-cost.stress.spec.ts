import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, test } from "vitest";
import { catalogueStore, canonicalJson, sha256Text } from "../../../src/catalogue/shared";
import {
  requiredEvidenceRun,
  startEvidenceRun,
  pendingEvidenceRequests,
  appendDiscoveredEvidenceRequests,
} from "../../../src/catalogue/source-evidence";
import {
  runRequestCapacityPolicy,
  type EvidenceRequestRow,
} from "../../../src/catalogue/source-evidence/source-evidence-repository";
import { sourceParseAuthorityGuard } from "../../../src/catalogue/source-evidence/source-parse-authority-repository";
import { installRuntimeSuite } from "./runtime-helpers";
import { paddingChunk } from "./source-discovery-admission-fixture";
import {
  seedAdmissionPlans,
  seedAdmissionRequests,
  populationFacts,
  proposalRows,
  reservation,
  diagnosticRunExists,
} from "./query-helpers/source-discovery-admission";
import {
  admissionDiagnostics,
  observeAdmissionBatchReads,
  type AdmissionPopulation,
  type AdmissionReadSample,
} from "./source-discovery-admission-observer";
import expected from "./fixtures/source-discovery-admission.json";

declare global {
  interface __BaseEnv_Env {
    SCRATCH_DB: D1Database;
  }
}

installRuntimeSuite();
const idempotencyKey = "327-native-admission-diagnostic-v1";
const ids = expected.proposal_identities.map((row) => row.id).sort();
const proposals = expected.proposals.map((row) => ({ ...row, role: "image" as const }));

test("bounded discovered admission preserves identities and limits native batch reads at two retained populations", async () => {
  expect(await sha256Text(canonicalJson(proposals))).toBe(expected.proposal_json_sha256);
  expect(env.CATALOGUE_DB).not.toBe(env.SCRATCH_DB);
  const diagnostics = admissionDiagnostics();
  const samples: AdmissionReadSample[] = [];
  const runIds: string[] = [];
  let current: AdmissionPopulation | null = null;
  try {
    for (const [index, population] of expected.populations.entries()) {
      const setupStarted = performance.now();
      const setupStartedAt = new Date().toISOString();
      const bindingName = index === 0 ? "CATALOGUE_DB" : "SCRATCH_DB";
      const native = index === 0 ? env.CATALOGUE_DB : env.SCRATCH_DB;
      const observed = diagnostics ? await diagnostics.startPopulation(native, population, bindingName) : native;
      const counter = observeAdmissionBatchReads(observed);
      const db = catalogueStore(counter.binding);
      // Migration helpers need the actual native binding, outside observation.
      if (index === 1) await applyD1Migrations(native, env.TEST_MIGRATIONS);
      expect(await diagnosticRunExists(db).bind(idempotencyKey).first()).toEqual({ count: 0 });
      const started = await startEvidenceRun(db, {
        supported_game: "magic",
        source_lineage: "scryfall-magic-en",
        adapter_version: "scryfall-magic-en@1",
        idempotency_key: idempotencyKey,
        requests: [{ id: expected.root.id, url: expected.root.url, headers: expected.root.headers }],
      });
      const run = await requiredEvidenceRun(db, String(started.id));
      const roots = await pendingEvidenceRequests(db, run.id);
      expect(roots).toHaveLength(1);
      expect(roots[0]!.request_id).toBe(expected.root.id);
      const [parent] = await appendDiscoveredEvidenceRequests(
        db,
        run,
        roots[0]!,
        [
          {
            role: "listing",
            url: expected.listing.url,
            headers: JSON.parse(expected.listing.headers_json) as Record<string, string>,
            discoveryKey: expected.listing.discovery_key,
          },
        ],
        () => sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
      );
      expect(parent!.request_id).toBe(expected.listing.id);
      expect(parent!.state).toBe("pending");
      current = { population, native, database: db, runId: run.id, parentId: parent!.request_id };
      expect(await populationFacts(db).bind(run.id, parent!.request_id).first()).toMatchObject({
        requests: 2,
        plans: 1,
        pending_images: 0,
        fetch_attempts: 0,
      });
      let digest = await sha256Text(expected.padding_chain_seed);
      for (let start = 0; start < population; start += 64) {
        const rows = await paddingChunk(start);
        expect(rows.every((row) => !ids.includes(row.id))).toBe(true);
        digest = await sha256Text(digest + "\n" + canonicalJson(rows));
        const rowsJson = JSON.stringify(rows);
        expect(rows).toHaveLength(64);
        expect(new TextEncoder().encode(rowsJson).length).toBeLessThanOrEqual(65536);
        await db.batch([
          sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
          seedAdmissionPlans(db).bind(run.id, parent!.request_id, rowsJson),
          seedAdmissionRequests(db, run.id, rowsJson, JSON.stringify(rows.map((row) => row.id))),
        ]);
        diagnostics?.seeded();
      }
      expect(digest).toBe((expected.population_digests as Record<string, string>)[String(population)]);
      expect((await proposalRows(db).bind(run.id, JSON.stringify(ids)).all()).results).toEqual([]);
      const before = await populationFacts(db).bind(run.id, parent!.request_id).first();
      expect(before).toEqual({
        requests: population + 2,
        plans: population + 1,
        pending_images: population,
        mismatches: 0,
        wrong_lineage: 0,
        wrong_parent: 0,
        fetch_attempts: 0,
      });
      expect(await reservation(db).bind(run.id).first()).toEqual({ ingestion_run_id: run.id });
      expect(await runRequestCapacityPolicy(db, run.id, "scryfall-magic-en@1")).toEqual({
        request_capacity: 108691,
        capacity_generation: 1,
      });
      await db.batch([sourceParseAuthorityGuard(db, run.id, { intent: "collection" })]);
      await diagnostics?.setupComplete({
        population,
        run_id: run.id,
        before,
        digest,
        binding: bindingName,
        setup_started_at: setupStartedAt,
        setup_ended_at: new Date().toISOString(),
        setup_wall_ms: performance.now() - setupStarted,
        migration_in_setup: index === 1,
      });
      let firstReturned: readonly EvidenceRequestRow[] | null = null;
      let firstRows: unknown = null;
      for (let call = 0; call <= expected.replays; call++) {
        await diagnostics?.startCall(call);
        counter.start();
        let admitted: readonly EvidenceRequestRow[];
        let rowsRead: number;
        try {
          admitted = await appendDiscoveredEvidenceRequests(db, run, parent!, proposals, () =>
            sourceParseAuthorityGuard(db, run.id, { intent: "collection" }),
          );
          rowsRead = counter.finish();
        } catch (error) {
          counter.finish();
          await diagnostics?.finishCall(call, false, error);
          throw error;
        }
        await diagnostics?.finishCall(call, true);
        samples.push({ population, call, rowsRead, budget: 2 * (population + 7) + 1024 });
        expect(admitted.map((row) => row.request_id).sort()).toEqual(ids);
        expect(admitted.every((row) => row.state === "pending")).toBe(true);
        expect(
          admitted.map(({ request_id, sequence_number, discovered_from_request_id }) => ({
            id: request_id,
            sequence: sequence_number,
            parent: discovered_from_request_id,
          })),
        ).toEqual(
          expected.proposal_identities.map(({ id }, index) => ({
            id,
            sequence: 1_000_001 + population + index,
            parent: expected.listing.id,
          })),
        );
        expect(
          admitted
            .map((row) => ({ id: row.request_id, fingerprint: row.representation_fingerprint }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ).toEqual([...expected.proposal_identities].sort((a, b) => a.id.localeCompare(b.id)));
        if (firstReturned === null) firstReturned = admitted;
        else expect(admitted).toEqual(firstReturned);
        const rows = (await proposalRows(db).bind(run.id, JSON.stringify(ids)).all()).results;
        if (firstRows === null) firstRows = rows;
        else expect(rows).toEqual(firstRows);
        expect(await populationFacts(db).bind(run.id, parent!.request_id).first()).toEqual({
          requests: population + 7,
          plans: population + 6,
          pending_images: population + 5,
          mismatches: 0,
          wrong_lineage: 0,
          wrong_parent: 0,
          fetch_attempts: 0,
        });
      }
      expect(await reservation(db).bind(run.id).first()).toEqual({ ingestion_run_id: run.id });
      expect(await runRequestCapacityPolicy(db, run.id, "scryfall-magic-en@1")).toEqual({
        request_capacity: 108691,
        capacity_generation: 1,
      });
      const finalRun = await requiredEvidenceRun(db, run.id);
      expect(finalRun.state).toBe("collecting");
      expect(finalRun.collection_completed_at).toBeNull();
      await diagnostics?.finishPopulation(current);
      runIds.push(run.id);
      current = null;
    }
    expect(runIds[0]).toBe(runIds[1]);
    expect(samples).toHaveLength(16);
    await diagnostics?.complete(samples);
  } catch (error) {
    await diagnostics?.failure(error, current);
    throw error;
  }
  // Finish both populations and every semantic check before the expected RED.
  // Allow required capacity traversal; bound repeated retained-plan work.
  expect(
    samples.filter(({ rowsRead, budget }) => rowsRead > budget),
    "source_discovery_admission_read_budget",
  ).toEqual([]);
}, 130_000);
