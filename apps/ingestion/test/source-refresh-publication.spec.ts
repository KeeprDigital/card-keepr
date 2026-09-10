import { expect, test } from "vitest";
import { nativeCandidateRecords, waitForNativeCandidates } from "./native-candidate-helpers";
import { approveNativeCandidateThroughBinding as approveNativeCandidate } from "./native-publication-helpers";
import { get, installReconciliationSuite } from "./reconciliation-helpers";
import { administrationRequest, resumeCollection, waitForEvidenceRun } from "./runtime-helpers";

installReconciliationSuite();
// Synthetic source evidence and injected outages; no real-source equivalence claim.
function sourcePlan(lineage: string, scenario: string, optional = false) {
  return {
    supported_game: "one-piece",
    source_lineage: lineage,
    adapter_version: lineage === "one-piece-en" ? "fixture-one-piece-json@3" : "fixture-limitless-json@1",
    participation: optional ? "optional" : "required",
    requests: [
      {
        id: `${lineage}:discovery`,
        url:
          scenario === "outage"
            ? "https://official-source.invalid/missing"
            : `https://official-source.invalid/reconciliation/${scenario}`,
      },
    ],
  };
}
async function refresh(plans: ReturnType<typeof sourcePlan>[], expectedState = "sealed") {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans,
    idempotency_key: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  await resumeCollection(id);
  const collection = await waitForEvidenceRun(id);
  if (collection.state === "failed") {
    expect(expectedState).toBe("failed");
    return { id, collection, candidate: undefined, records: undefined };
  }
  const [candidate] = await waitForNativeCandidates(id, 1, 15_000, { "one-piece": expectedState });
  return {
    id,
    collection,
    candidate: candidate!,
    records: expectedState === "sealed" ? await nativeCandidateRecords(String(candidate!.id)) : undefined,
  };
}

async function publishRefresh(run: Awaited<ReturnType<typeof refresh>>) {
  if (!run.candidate) throw new Error("Failed collection has no approvable native candidate.");
  return approveNativeCandidate(run.candidate, `refresh-publication-${run.id}`);
}

test("official-only and optional-outage refreshes preserve accepted supplemental Printings and their check dates", async () => {
  const intake = await refresh([
    sourcePlan("one-piece-en", "base"),
    sourcePlan("limitless-one-piece-en", "source-refresh-supplemental"),
  ]);
  // Preserve the original owner decision to decline this intake before admitting
  // supplemental evidence: native candidates use explicit abandonment.
  expect(
    (
      await administrationRequest(`/v1/game-candidates/${intake.candidate!.id}/abandon`, "POST", {
        generation: intake.candidate!.generation,
        idempotency_key: "inspect-supplemental-intake",
      })
    ).status,
  ).toBe(200);
  const proposals = await get("/v1/entity-proposals?game=one-piece");
  const proposal = (proposals.document.proposals as { id: string }[])[0]!;
  expect(
    (
      await administrationRequest(`/v1/entity-proposals/${proposal.id}/decisions`, "POST", {
        action: "admit",
        expected_generation: "0",
        rationale: "Owner reviewed retained synthetic supplemental evidence",
        idempotency_key: "admit-supplemental-refresh-fixture",
      })
    ).status,
  ).toBe(200);
  const initial = await refresh([
    sourcePlan("one-piece-en", "base"),
    sourcePlan("limitless-one-piece-en", "source-refresh-supplemental"),
  ]);
  expect(initial.candidate!.state).toBe("sealed");
  const printings = initial.records!.printings!.map((printing) => String(printing.id));
  expect(printings).toHaveLength(2);
  const initialPublication = await publishRefresh(initial);
  expect(initialPublication.response.status).toBe(200);
  const initialRevision = initialPublication.document.resulting_revision_id;
  const initialChecks = await get(`/v1/ingestion-runs/${initial.id}/evidence`);
  const official = await refresh([sourcePlan("one-piece-en", "base")]);
  expect(official.candidate!.state).toBe("sealed");
  expect((await publishRefresh(official)).document.resulting_revision_id).toBe(initialRevision);
  for (const id of printings) expect((await get(`/v1/reconciliation/printings/${id}`)).response.status).toBe(200);
  const supplemental = await refresh([sourcePlan("limitless-one-piece-en", "source-refresh-supplemental")]);
  expect(supplemental.candidate!.state).toBe("sealed");
  expect((await publishRefresh(supplemental)).document.resulting_revision_id).toBe(initialRevision);
  const outage = await refresh([
    sourcePlan("one-piece-en", "base"),
    sourcePlan("limitless-one-piece-en", "outage", true),
  ]);
  expect([...(outage.records!.warnings ?? []), ...(outage.records!.shared_warnings ?? [])]).toContainEqual(
    expect.objectContaining({ code: "optional_source_carried_forward", source_lineage: "limitless-one-piece-en" }),
  );
  expect((await publishRefresh(outage)).document.resulting_revision_id).toBe(initialRevision);
  expect((await get(`/v1/ingestion-runs/${initial.id}/evidence`)).document.source_coverage).toEqual(
    initialChecks.document.source_coverage,
  );
  const checks = (await get(`/v1/ingestion-runs/${official.id}/evidence`)).document.source_coverage as {
    successful_checked_at: string;
    content_captured_at: string;
  }[];
  expect(checks[0]!.successful_checked_at > checks[0]!.content_captured_at).toBe(true);
  const competing = await refresh([sourcePlan("limitless-one-piece-en", "base")], "failed");
  expect(competing.candidate?.state ?? competing.collection.state).toBe("failed");
}, 30_000);

test("explicit reinstatement preserves the withdrawn Printing identity and attributable history", async () => {
  const withdrawn = await refresh([sourcePlan("one-piece-en", "withdrawn")]);
  expect(withdrawn.candidate!.state).toBe("sealed");
  const id = String(withdrawn.records!.printings![0]!.id);
  expect((await publishRefresh(withdrawn)).response.status).toBe(200);
  expect((await get(`/v1/reconciliation/printings/${id}`)).document.lifecycle).toMatchObject({ withdrawn: true });
  const reinstated = await refresh([sourcePlan("one-piece-en", "reinstated")]);
  expect(reinstated.candidate!.state).toBe("sealed");
  expect(reinstated.records!.printings!.map((printing) => String(printing.id))).toContain(id);
  expect((await publishRefresh(reinstated)).response.status).toBe(200);
  expect((await get(`/v1/reconciliation/printings/${id}`)).document.lifecycle).toMatchObject({
    withdrawn: false,
    withdrawal: { evidence: { state: "reinstated", effective_at: "2026-08-01T00:00:00.000Z" } },
  });
  expect((await get(`/v1/ingestion-runs/${withdrawn.id}/evidence`)).document.snapshots).not.toHaveLength(0);
}, 30_000);

test("unexplained substantial coverage loss blocks completeness rather than becoming ordinary disappearance", async () => {
  // 26 -> 1 reaches the 25-record coverage-loss boundary.
  const full = await refresh([sourcePlan("one-piece-en", "observation-count-26")]);
  expect(full.candidate!.state).toBe("sealed");
  expect((await publishRefresh(full)).response.status).toBe(200);
  const loss = await refresh([sourcePlan("one-piece-en", "base")], "failed");
  expect(loss.candidate?.state ?? loss.collection.state).toBe("failed");
  const evidence = await get(`/v1/ingestion-runs/${loss.id}/evidence`);
  expect(evidence.document.source_coverage).toEqual(
    expect.arrayContaining([expect.objectContaining({ successful_checked_at: null, status: "incomplete" })]),
  );
  const narrower = await refresh([
    {
      ...sourcePlan("one-piece-en", "errata-card-rules-text"),
      adapter_version: "fixture-one-piece-refresh-errata@1",
      requests: [
        {
          id: "one-piece-en:errata",
          url: "https://official-source.invalid/reconciliation/source-refresh-empty-errata",
        },
      ],
    },
  ]);
  expect(narrower.id).not.toBe(loss.id);
  expect(narrower.candidate!.state).toBe("sealed");
  expect((await get(`/v1/ingestion-runs/${narrower.id}/evidence`)).document.source_coverage).toEqual([
    expect.objectContaining({ coverage: { area: "errata", locale: "en", subset: "complete" }, status: "complete" }),
  ]);
});

test.each(["revalidated", "reverted"])(
  "%s content dates follow selected snapshot provenance",
  async (scenario) => {
    const selected = sourcePlan("one-piece-en", "base");
    selected.requests[0]!.url = `https://official-source.invalid/source-refresh-${scenario}`;
    const captures: { captured: string; retrieved: string; reused: string | null }[] = [];
    for (let index = 0; index < 3; index++) {
      const run = await refresh([selected]);
      expect(run.candidate!.state).toBe("sealed");
      const evidence = (await get(`/v1/ingestion-runs/${run.id}/evidence`)).document;
      const scope = (evidence.source_coverage as { content_captured_at: string }[])[0]!;
      const snapshot = (
        evidence.snapshots as { retrieval: { retrieved_at: string }; reused_source_snapshot_id: string | null }[]
      )[0]!;
      captures.push({
        captured: scope.content_captured_at,
        retrieved: snapshot.retrieval.retrieved_at,
        reused: snapshot.reused_source_snapshot_id,
      });
      expect((await publishRefresh(run)).response.status).toBe(200);
    }
    if (scenario === "revalidated") {
      expect(captures[2]!.reused).not.toBeNull();
      expect(captures[2]!.captured).toBe(captures[0]!.retrieved);
    } else {
      expect(captures[2]!.reused).toBeNull();
      expect(captures[2]!.captured).toBe(captures[2]!.retrieved);
      expect(captures[2]!.captured > captures[0]!.captured).toBe(true);
    }
  },
  30_000,
);
