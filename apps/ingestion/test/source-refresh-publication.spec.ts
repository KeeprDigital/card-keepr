import { beforeEach, describe, expect, test } from "vitest";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeEvidence } from "./native-publication-helpers";
import { get, installReconciliationSuite, postFixtureEvidence, testEnv } from "./reconciliation-helpers";
import { administrationRequest } from "./runtime-helpers";

import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { currentGameMembers } from "./query-helpers/atomic-publication";

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
async function refresh(plans: ReturnType<typeof sourcePlan>[], expectedState: "sealed" | "failed" = "sealed") {
  const started = await postFixtureEvidence({ plans, idempotency_key: crypto.randomUUID() });
  const id = String(started.document.id);
  const collection = await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    id,
  );
  if (collection.state === "failed") {
    expect(expectedState).toBe("failed");
    return { id, collection, candidate: undefined, records: undefined };
  }
  const members = await currentGameMembers(testEnv.CATALOGUE_DB);
  const predecessor =
    members.results.find((member) => member.supported_game === "one-piece")?.game_revision_id ?? "catrev_spine_000";
  const candidate = await prepareNativeEvidence({
    runId: id,
    game: "one-piece",
    predecessor,
    key: `refresh-${id}`,
    expectedState,
  });
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

describe("refreshing accepted supplemental evidence", () => {
  let initial: Awaited<ReturnType<typeof refresh>>;
  let printings: string[];
  let initialRevision: unknown;
  let initialChecks: Awaited<ReturnType<typeof get>>;

  // Every case owns a fresh, genuinely published and backup-verified predecessor.
  // Setup has its own hook deadline; no case depends on a previous test's writes.
  beforeEach(async () => {
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
    initial = await refresh([
      sourcePlan("one-piece-en", "base"),
      sourcePlan("limitless-one-piece-en", "source-refresh-supplemental"),
    ]);
    expect(initial.candidate!.state).toBe("sealed");
    printings = initial.records!.printings!.map((printing) => String(printing.id));
    expect(printings).toHaveLength(2);
    const initialPublication = await publishRefresh(initial);
    expect(initialPublication.response.status).toBe(200);
    initialRevision = initialPublication.document.resulting_revision_id;
    initialChecks = await get(`/v1/ingestion-runs/${initial.id}/evidence`);
  });

  test.each(["official-only", "supplemental-only", "optional-outage"])(
    "%s refresh preserves accepted Printings and their source proof",
    async (scenario) => {
      const plans =
        scenario === "supplemental-only"
          ? [sourcePlan("limitless-one-piece-en", "source-refresh-supplemental")]
          : [
              sourcePlan("one-piece-en", "base"),
              ...(scenario === "optional-outage" ? [sourcePlan("limitless-one-piece-en", "outage", true)] : []),
            ];
      const refreshed = await refresh(plans);
      expect(refreshed.candidate!.state).toBe("sealed");
      if (scenario === "optional-outage") {
        expect([...(refreshed.records!.warnings ?? []), ...(refreshed.records!.shared_warnings ?? [])]).toContainEqual(
          expect.objectContaining({
            code: "optional_source_carried_forward",
            source_lineage: "limitless-one-piece-en",
          }),
        );
      }
      expect((await publishRefresh(refreshed)).document.resulting_revision_id).toBe(initialRevision);
      for (const id of printings) expect((await get(`/v1/reconciliation/printings/${id}`)).response.status).toBe(200);
      expect((await get(`/v1/ingestion-runs/${initial.id}/evidence`)).document.source_coverage).toEqual(
        initialChecks.document.source_coverage,
      );
      if (scenario === "official-only") {
        const checks = (await get(`/v1/ingestion-runs/${refreshed.id}/evidence`)).document.source_coverage as {
          successful_checked_at: string;
          content_captured_at: string;
        }[];
        expect(checks[0]!.successful_checked_at > checks[0]!.content_captured_at).toBe(true);
      }
      if (scenario === "optional-outage") {
        // The outage cannot replace the accepted proof or admit a competing scope.
        const afterOutage = await refresh([sourcePlan("limitless-one-piece-en", "source-refresh-supplemental")]);
        expect(afterOutage.candidate!.state).toBe("sealed");
        expect(
          (
            await administrationRequest(`/v1/game-candidates/${afterOutage.candidate!.id}/abandon`, "POST", {
              generation: afterOutage.candidate!.generation,
              idempotency_key: "after-outage-proof-inspected",
            })
          ).status,
        ).toBe(200);
        const competing = await refresh([sourcePlan("limitless-one-piece-en", "base")], "failed");
        expect(competing.candidate?.state ?? competing.collection.state).toBe("failed");
      }
    },
  );
});

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
