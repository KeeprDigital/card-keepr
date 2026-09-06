import { expect, test } from "vitest";
import { administrationRequest, resumeCollection, waitForEvidenceRun } from "./runtime-helpers";
import { installReconciliationSuite, approve, get, reconcile } from "./reconciliation-helpers";

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
async function refresh(plans: ReturnType<typeof sourcePlan>[]) {
  const response = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    plans,
    idempotency_key: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  await resumeCollection(id);
  if (plans.every((plan) => plan.adapter_version === "fixture-one-piece-refresh-errata@1")) {
    const outcome = await reconcile(id);
    expect(outcome.document, JSON.stringify(outcome.document)).toMatchObject({ publishable: true });
  }
  const completed = await waitForEvidenceRun(id, "awaiting_approval");
  return { id, state: completed.state, result: await get(`/v1/ingestion-runs/${id}/candidate`) };
}

test("official-only and optional-outage refreshes preserve accepted supplemental Printings and their check dates", async () => {
  const initial = await refresh([
    sourcePlan("one-piece-en", "base"),
    sourcePlan("limitless-one-piece-en", "new-locator"),
  ]);
  expect(initial.state).toBe("awaiting_approval");
  const printings = (initial.result.document.diff as { printings: { added: string[] } }).printings.added;
  expect(printings).toHaveLength(2);
  expect((await approve(initial.result.document)).response.status).toBe(200);
  const initialChecks = await get(`/v1/ingestion-runs/${initial.id}/evidence`);
  const official = await refresh([sourcePlan("one-piece-en", "base")]);
  expect(official.state).toBe("awaiting_approval");
  expect((await approve(official.result.document)).document.publication_outcome).toBe("no_change");
  for (const id of printings) expect((await get(`/v1/reconciliation/printings/${id}`)).response.status).toBe(200);
  const outage = await refresh([
    sourcePlan("one-piece-en", "base"),
    sourcePlan("limitless-one-piece-en", "outage", true),
  ]);
  expect((outage.result.document.diff as { warnings: unknown[] }).warnings).toContainEqual(
    expect.objectContaining({ code: "optional_source_carried_forward", source_lineage: "limitless-one-piece-en" }),
  );
  expect((await approve(outage.result.document)).document.publication_outcome).toBe("no_change");
  expect((await get(`/v1/ingestion-runs/${initial.id}/evidence`)).document.source_coverage).toEqual(
    initialChecks.document.source_coverage,
  );
  const checks = (await get(`/v1/ingestion-runs/${official.id}/evidence`)).document.source_coverage as {
    successful_checked_at: string;
    content_captured_at: string;
  }[];
  expect(checks[0]!.successful_checked_at > checks[0]!.content_captured_at).toBe(true);
}, 30_000);

test("explicit reinstatement preserves the withdrawn Printing identity and attributable history", async () => {
  const withdrawn = await refresh([sourcePlan("one-piece-en", "withdrawn")]);
  expect(withdrawn.state).toBe("awaiting_approval");
  const id = (withdrawn.result.document.diff as { printings: { added: string[] } }).printings.added[0]!;
  expect((await approve(withdrawn.result.document)).response.status).toBe(200);
  expect((await get(`/v1/reconciliation/printings/${id}`)).document.lifecycle).toMatchObject({ withdrawn: true });
  const reinstated = await refresh([sourcePlan("one-piece-en", "reinstated")]);
  expect(reinstated.state).toBe("awaiting_approval");
  expect(
    (reinstated.result.document.diff as { printings: { identity_matches: string[] } }).printings.identity_matches,
  ).toContain(id);
  expect((await approve(reinstated.result.document)).response.status).toBe(200);
  expect((await get(`/v1/reconciliation/printings/${id}`)).document.lifecycle).toMatchObject({
    withdrawn: false,
    withdrawal: { evidence: { state: "reinstated", effective_at: "2026-08-01T00:00:00.000Z" } },
  });
  expect((await get(`/v1/ingestion-runs/${withdrawn.id}/evidence`)).document.snapshots).not.toHaveLength(0);
}, 30_000);

test("unexplained substantial coverage loss blocks completeness rather than becoming ordinary disappearance", async () => {
  const full = await refresh([sourcePlan("one-piece-en", "observation-count-100")]);
  expect(full.state).toBe("awaiting_approval");
  expect((await approve(full.result.document)).response.status).toBe(200);
  const loss = await refresh([sourcePlan("one-piece-en", "base")]);
  expect(loss.state).toBe("failed");
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
  expect(narrower.state).toBe("awaiting_approval");
  expect((await get(`/v1/ingestion-runs/${narrower.id}/evidence`)).document.source_coverage).toEqual([
    expect.objectContaining({ coverage: { area: "errata", locale: "en", subset: "complete" }, status: "complete" }),
  ]);
});
