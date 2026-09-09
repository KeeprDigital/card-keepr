import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { PublicationIntegrityError } from "./publication-preparation-types";
import {
  priorPublicLifecycle,
  publicationObservedPlan,
  type PublicLifecycleFact,
} from "./publication-lifecycle-repository";

/** One entity, one prior fact and one bounded verified observation plan. */
export async function preparePublicLifecycle(
  db: CatalogueStore,
  candidate: { id: string; preparation_id: string; expected_game_revision_id: string; supported_game: string },
  kind: string,
  value: Record<string, unknown>,
): Promise<PublicLifecycleFact | null> {
  if (!["cards", "printings", "products", "product_relationships", "relationships"].includes(kind)) return null;
  const id = String(value.id);
  const prior = await priorPublicLifecycle(
    db,
    candidate.expected_game_revision_id,
    candidate.supported_game,
    kind,
    id,
    candidate.preparation_id,
  ).first<PublicLifecycleFact>();
  let observed = false;
  let withdrawal: Record<string, unknown> | null = null;
  let observationDigest: string | null = null;
  if (kind === "cards" || kind === "printings") {
    const plan = await publicationObservedPlan(
      db,
      candidate.preparation_id,
      candidate.expected_game_revision_id,
      candidate.supported_game,
      kind,
      id,
    ).first<{ content: string; sha256: string; newly_observed: number }>();
    if (plan) {
      if ((await sha256Text(plan.content)) !== plan.sha256)
        throw new PublicationIntegrityError("publication_observation_corrupt");
      const fact = JSON.parse(plan.content).value.plan;
      observed = plan.newly_observed === 1;
      const selected = fact.withdrawal;
      if (
        selected &&
        (selected.entity === "card_and_printing" || selected.entity === (kind === "cards" ? "card" : "printing"))
      )
        withdrawal = selected;
    }
  } else if (kind === "products" && value.membership_evidence !== undefined) {
    const receipt = value.membership_evidence as { sha256: string; count: number };
    if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(receipt.count) || receipt.count < 1)
      throw new PublicationIntegrityError("publication_observation_corrupt");
    observationDigest = receipt.sha256;
    observed = value.observed === true && observationDigest !== prior?.observation_digest;
  } else {
    observationDigest = await sha256Text(
      canonicalJson(value.source_observations ?? value.source_observation_ids ?? value.provenance ?? []),
    );
    observed = value.observed === true && observationDigest !== prior?.observation_digest;
    if (value.withdrawal && typeof value.withdrawal === "object")
      withdrawal = value.withdrawal as Record<string, unknown>;
  }
  const relationship = kind === "product_relationships" || kind === "relationships";
  const withdrawn = relationship
    ? Number(value.observed === false)
    : withdrawal
      ? Number(kind === "products" || withdrawal.state === "withdrawn")
      : (prior?.withdrawn ?? 0);
  const transition = (relationship || withdrawal !== null) && withdrawn !== (prior?.withdrawn ?? 0);
  const evidence = transition ? canonicalJson(withdrawal) : (prior?.withdrawal_evidence_json ?? null);
  if (evidence !== null && new TextEncoder().encode(evidence).byteLength > 131072)
    throw new PublicationIntegrityError("publication_capacity_exceeded");
  return {
    candidate_id: candidate.id,
    kind,
    entity_id: id,
    first_candidate_id: prior?.first_candidate_id ?? candidate.id,
    last_observed_candidate_id: observed ? candidate.id : (prior?.last_observed_candidate_id ?? candidate.id),
    withdrawn,
    withdrawal_candidate_id:
      transition && (!relationship || withdrawn === 1) ? candidate.id : (prior?.withdrawal_candidate_id ?? null),
    withdrawal_evidence_json: evidence,
    observation_digest: observationDigest,
  };
}
