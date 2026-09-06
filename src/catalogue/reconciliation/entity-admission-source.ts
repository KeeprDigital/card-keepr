import { sources, sourceLineages } from "../adapters";
import type { sourceAuthorities } from "../source-evidence";
import {
  canonicalJson,
  sha256Text,
  exportedGameProfileSchema,
  type CatalogueStore,
  type CatalogueCard,
  type CataloguePrinting,
} from "../shared";
import type { ParsedCardPrintingObservation } from "./reconciliation-observation";
import {
  admissionPinStatement,
  latestAdmissionStatement,
  pinnedAdmissionStatement,
  proposalReferenceStatement,
  insertProposalStatement,
  insertAdmissionDecisionStatement,
  retainProposalEvidenceStatement,
  type EntityProposalRow,
  type AdmissionDecisionRow,
} from "./entity-admission-repository";

type SourceObservation = ParsedCardPrintingObservation & {
  sourceLineage: string;
  sourceSnapshotId: string;
  sourceObservationSetId: string;
};
export async function sourceAdmissionPolicy(
  database: CatalogueStore,
  sourceLineage: string,
  profile: string,
  run: string,
) {
  const lineage = sourceLineages.find((s) => s.id === sourceLineage);
  const pin = await admissionPinStatement(database, run).first<{ policy_json: string }>();
  if (!pin) throw new Error("Admission requires the run's immutable policy snapshot.");
  const { authorities } = JSON.parse(pin.policy_json) as Awaited<ReturnType<typeof sourceAuthorities>>;
  const automatic =
    !!lineage &&
    ["card_facts", "printing_details"].every((area) =>
      authorities.some(
        (a) =>
          a.game === lineage.game &&
          a.locale === lineage.locale &&
          a.release_region === lineage.release_region &&
          a.area === area &&
          a.source_lineage === sourceLineage,
      ),
    );
  return { automatic, digest: await admissionPolicyDigest(sourceLineage, profile) };
}
export async function admissionPolicyDigest(sourceLineage: string, profile: string) {
  const requirements = {
    profile: exportedGameProfileSchema(profile),
    source_lineage: sourceLineage,
    real_card: sourceLineage === "owner" ? "owner_retained_evidence" : "retained_structured_record",
    identity: "unambiguous",
    printing: "explicit_novel_appearance",
    exceptions: ["source_evidence", "identity"],
  };
  return sha256Text(canonicalJson(requirements));
}

export function supplementalLineage(lineage: string) {
  const registration = sourceLineages.find((source) => source.id === lineage);
  return (
    registration !== undefined && sources.find((source) => source.id === registration.source_id)?.publisher_id === null
  );
}
export async function assessSourceAdmission(
  database: CatalogueStore,
  run: string,
  observation: SourceObservation,
  at: string,
) {
  if (!supplementalLineage(observation.sourceLineage) || !observation.observedCardAndPrinting.card) return null;
  const reference = canonicalJson([
    observation.locator ?? observation.observedCardAndPrinting.card.official_identity,
    observation.variantKey,
  ]);
  let proposal = await proposalReferenceStatement(
    database,
    observation.sourceLineage,
    reference,
  ).first<EntityProposalRow>();
  if (!proposal) {
    const content = canonicalJson(observation.observedCardAndPrinting);
    const evidence = canonicalJson({
      source_snapshot_id: observation.sourceSnapshotId,
      source_observation_set_id: observation.sourceObservationSetId,
      source_observation_id: observation.sourceObservationId,
      demonstrably_novel: observation.demonstrablyNovel,
      novelty_proof_complete: observation.noveltyProofComplete,
    });
    const id = `proposal_${await sha256Text(canonicalJson([observation.sourceLineage, reference]))}`;
    proposal = {
      id,
      game: observation.observedCardAndPrinting.card.game,
      source_lineage: observation.sourceLineage,
      reference,
      content_json: content,
      evidence_json: evidence,
      idempotency_key: id,
      request_json: canonicalJson([content, evidence]),
      created_at: at,
    };
    await insertProposalStatement(database, proposal, run).run();
  }
  await retainProposalEvidenceStatement(
    database,
    proposal.id,
    run,
    observation.sourceSnapshotId,
    observation.sourceObservationId,
  ).run();
  const pinned = await pinnedAdmissionStatement(database, run, proposal.id).first<AdmissionDecisionRow>();
  const latest = pinned ?? (await latestAdmissionStatement(database, proposal.id).first<AdmissionDecisionRow>());
  const policy = await sourceAdmissionPolicy(
    database,
    observation.sourceLineage,
    observation.observedCardAndPrinting.card.game_data.profile,
    run,
  );
  const decision =
    (latest?.action === "admit" || latest?.action === "link") && latest.decision_json
      ? (JSON.parse(latest.decision_json) as {
          card: CatalogueCard;
          printing: CataloguePrinting | null;
          policy_digest?: string;
          exception?: unknown;
        })
      : null;
  const admitted = latest?.action === "admit" || latest?.action === "link";
  const rejected = latest?.action === "reject";
  const exceptionChanged =
    admitted &&
    latest?.actor === "owner" &&
    proposal.content_json !== canonicalJson(observation.observedCardAndPrinting);
  const permitted =
    (admitted && !exceptionChanged) ||
    (!admitted &&
      !rejected &&
      policy.automatic &&
      (observation.observedCardAndPrinting.printing === null ||
        (observation.demonstrablyNovel && observation.noveltyProofComplete && observation.artworkIdentityExplicit)));
  return { proposal, latest, policy, permitted, rejected, decision, exceptionChanged };
}
export async function completeSourceAdmission(
  database: CatalogueStore,
  run: string,
  admission: NonNullable<Awaited<ReturnType<typeof assessSourceAdmission>>>,
  card: CatalogueCard,
  printing: CataloguePrinting | null,
  at: string,
) {
  if (admission.latest?.action === "admit" || admission.latest?.action === "link") return;
  const generation = (admission.latest?.generation ?? 0) + 1;
  const decision = {
    card,
    printing,
    linked: false,
    warnings: [],
    exception: null,
    policy_digest: admission.policy.digest,
    publisher_confirmed_fields: [],
  };
  const key = `auto_${run}_${admission.proposal.id}`;
  await insertAdmissionDecisionStatement(
    database,
    {
      proposal_id: admission.proposal.id,
      generation,
      action: "admit",
      actor: "automation",
      rationale:
        "Designated supplemental authority satisfied the game/source admission rules and unambiguous identity checks.",
      decision_json: canonicalJson(decision),
      idempotency_key: key,
      request_json: canonicalJson(decision),
      decided_at: at,
    },
    run,
  ).run();
}

/** A publisher can confirm only concrete facts actually present in its evidence.
 * This annotation never participates in identity matching or authority selection. */
export function publisherConfirmation(lineage: string, observed: unknown, accepted: unknown) {
  const registration = sourceLineages.find((source) => source.id === lineage);
  if (!registration || !sources.find((source) => source.id === registration.source_id)?.publisher_id) return null;
  const fields: string[] = [];
  const visit = (evidence: unknown, value: unknown, path: string) => {
    if (evidence === null || evidence === undefined || value === undefined) return;
    if (typeof evidence === "object" && !Array.isArray(evidence)) {
      for (const [key, child] of Object.entries(evidence)) {
        if (key === "id" || key === "card_id" || key === "curated_provenance") continue;
        visit(
          child,
          value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
          path ? `${path}.${key}` : key,
        );
      }
    } else if (canonicalJson(evidence) === canonicalJson(value)) fields.push(path);
  };
  visit(observed, accepted, "");
  return { fields: fields.sort() };
}
