import type { CatalogueStore } from "../shared";
import type { IngestionEvidenceRow } from "./ingestion-run-repository";
import type { EvidencePlan } from "./source-evidence-model";
import { sourceCoverageCountsStatement } from "./source-coverage-repository";

export async function inspectSourceCoverage(
  database: CatalogueStore,
  run: IngestionEvidenceRow,
  plans: readonly EvidencePlan[],
) {
  const scopes = new Map<string, EvidencePlan>();
  for (const plan of plans) {
    const existing = scopes.get(plan.source_lineage);
    scopes.set(plan.source_lineage, existing ? { ...plan, requests: [...existing.requests, ...plan.requests] } : plan);
  }
  return Promise.all(
    [...scopes.values()].map(async (plan) => {
      const counts = await sourceCoverageCountsStatement(database, run.id, plan).first<{
        planned_requests: number;
        observed_requests: number;
        last_capture_at: string | null;
        content_captured_at: string | null;
        revalidated_requests: number;
      }>();
      const complete =
        counts !== null &&
        counts.planned_requests > 0 &&
        counts.planned_requests === counts.observed_requests &&
        run.candidate_digest !== null &&
        run.failure_code === null;
      return {
        source_lineage: plan.source_lineage,
        supported_game: plan.supported_game,
        adapter_version: plan.adapter_version,
        participation: plan.participation,
        coverage: plan.coverage,
        status: complete ? "complete" : "incomplete",
        attempted_at: run.started_at,
        successful_checked_at: complete ? run.collection_completed_at : null,
        content_captured_at: complete ? counts.content_captured_at : null,
        last_capture_at: counts?.last_capture_at ?? null,
        planned_requests: counts?.planned_requests ?? 0,
        observed_requests: counts?.observed_requests ?? 0,
        revalidated_requests: counts?.revalidated_requests ?? 0,
      };
    }),
  );
}
