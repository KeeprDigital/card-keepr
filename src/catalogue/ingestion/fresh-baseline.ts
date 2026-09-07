import { AdministrationProblem, type CatalogueStore } from "../shared";
import { freshBaselineHandoffStatement } from "./fresh-baseline-repository";

/** Friendly HTTP rejection; database triggers remain the race-free authority. */
export async function enforceFreshBaselineMutationGuard(
  database: CatalogueStore,
  method: string,
  path: string,
): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(method) || path === "/v1/production-releases") return;
  const handoff = await freshBaselineHandoffStatement(database).first<{ role: string; phase: number }>();
  if (
    handoff !== null &&
    ((handoff.role === "source" && handoff.phase !== 7) || (handoff.role === "destination" && handoff.phase !== 6))
  )
    throw new AdministrationProblem(
      409,
      "fresh_baseline_mutation_fenced",
      "The fresh-baseline handoff retains mutation authority. Inspect status and resume or safely cancel the exact confirmed handoff.",
    );
}
