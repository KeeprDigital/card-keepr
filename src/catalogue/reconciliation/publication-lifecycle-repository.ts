import { type CatalogueStore, repositoryStatements } from "../shared";
import { gamePredecessorCandidateSql } from "./game-candidate-predecessor-repository";

export type PublicLifecycleFact = {
  candidate_id: string;
  kind: string;
  entity_id: string;
  first_candidate_id: string;
  last_observed_candidate_id: string;
  withdrawn: number;
  withdrawal_candidate_id: string | null;
  withdrawal_evidence_json: string | null;
  observation_digest: string | null;
};
export function priorPublicLifecycle(
  db: CatalogueStore,
  revision: string,
  game: string,
  kind: string,
  id: string,
  preparation: string,
) {
  return repositoryStatements(db)
    .prepare(`SELECT l.* FROM publication_read_lifecycles l
 WHERE l.candidate_id=${gamePredecessorCandidateSql("?1", "?2", "?5")} AND l.kind=?3 AND l.entity_id=?4`)
    .bind(revision, game, kind, id, preparation);
}
export function publicationObservedPlan(
  db: CatalogueStore,
  preparation: string,
  revision: string,
  game: string,
  kind: string,
  id: string,
) {
  const path = kind === "cards" ? "$.value.plan.cardId" : "$.value.plan.printingId";
  return repositoryStatements(db)
    .prepare(`SELECT plan.content,plan.sha256,
 MAX(NOT EXISTS(SELECT 1 FROM game_candidates prior
 JOIN reconciliation_reducer_state old ON old.preparation_id=prior.preparation_id AND old.namespace='observation_plans'
 AND old.key_digest=plan.key_digest AND json_extract(old.content,'${path}')=?4
 WHERE prior.id=${gamePredecessorCandidateSql("?2", "?3", "?1")})) OVER() AS newly_observed
 FROM reconciliation_reducer_state plan WHERE plan.preparation_id=?1 AND plan.namespace='observation_plans'
 AND json_extract(plan.content,'${path}')=?4 AND json_extract(plan.content,'$.value.plan.observationKind')='card_printing'
 ORDER BY json_extract(plan.content,'$.value.plan.withdrawal.effective_at') DESC,plan.observation_ordinal DESC LIMIT 1`)
    .bind(preparation, revision, game, id);
}
export function retainPublicLifecycle(db: CatalogueStore, f: PublicLifecycleFact) {
  return repositoryStatements(db)
    .prepare(`INSERT INTO publication_read_lifecycles VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(
      f.candidate_id,
      f.kind,
      f.entity_id,
      f.first_candidate_id,
      f.last_observed_candidate_id,
      f.withdrawn,
      f.withdrawal_candidate_id,
      f.withdrawal_evidence_json,
      f.observation_digest,
    );
}
