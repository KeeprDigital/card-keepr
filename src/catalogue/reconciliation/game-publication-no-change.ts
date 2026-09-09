import { AdministrationProblem, type CatalogueStore, sha256Text } from "../shared";
import {
  publicationCompositionHead,
  publicationCheckpointStatement,
  publicationOperationStatement,
  unchangedPublicationStatements,
} from "./game-publication-repository";
import { equalGameSemanticsStatement, unchangedPublicPackageStatement } from "./game-publication-no-change-repository";

type Outcome = { state: "published" | "waiting_backup" | "retry_paused" | "failed"; failure_code?: string };

/** Reuse a verified bounded public root, then accept fresh evidence in one small transaction. */
export async function acceptUnchangedGamePublication(
  env: { CATALOGUE_DB: CatalogueStore; CATALOGUE_EXPORTS: R2Bucket },
  input: { id: string; candidateId: string; generation: number; clockOffsetMs: number },
): Promise<Outcome | null> {
  const db = env.CATALOGUE_DB;
  if (!(await equalGameSemanticsStatement(db, input.candidateId).first<{ equal: number }>())?.equal) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = (await publicationCompositionHead(db).first<{ current_revision_id: string }>())!
      .current_revision_id;
    if (!(await publicationCheckpointStatement(db, revision).first<{ ready: number }>())?.ready)
      return { state: "waiting_backup" };
    const manifest = await unchangedPublicPackageStatement(db, revision).first<{
      digest: string;
      object_key: string;
    }>();
    if (!manifest)
      throw new AdministrationProblem(
        409,
        "publication_artifacts_unverified",
        "The retained public package is unavailable.",
      );
    const object = await env.CATALOGUE_EXPORTS.get(manifest.object_key);
    if (!object || object.size > 16384 || (await sha256Text(await object.text())) !== manifest.digest)
      throw new AdministrationProblem(
        409,
        "publication_artifacts_unverified",
        "The retained public package failed verification.",
      );
    try {
      await db.batch(
        unchangedPublicationStatements(db, {
          id: input.id,
          generation: input.generation,
          predecessor: revision,
          revision,
          composition: manifest.digest,
          backup: `backup_${input.id.slice("publication_".length)}`,
          at: new Date(Date.now() + input.clockOffsetMs).toISOString(),
          clockOffsetMs: input.clockOffsetMs,
        }),
      );
      return { state: "published" };
    } catch (error) {
      const current = await publicationOperationStatement(db, input.id).first<{ state: string }>();
      if (current?.state === "published") return { state: "published" };
      const detail = error instanceof Error ? error.message : "";
      if (/publication_(deadline_expired|candidate_conflict)/u.test(detail))
        return {
          state: "failed",
          failure_code: detail.includes("deadline_expired")
            ? "publication_deadline_expired"
            : "publication_candidate_conflict",
        };
      if (detail.includes("publication_composition_conflict")) continue;
      if (detail.includes("publication_backup_pending")) return { state: "waiting_backup" };
      throw error;
    }
  }
  return { state: "retry_paused", failure_code: "publication_composition_contention" };
}
