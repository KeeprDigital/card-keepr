import { type CatalogueStore, canonicalJson, decodeDocument, sha256Text } from "../shared";
import { retainEvidenceObjectReferenceStatement } from "../source-evidence";
import type { SourceAdapterRegistration } from "../adapters";
import {
  insertProposalStatement,
  proposalReferenceStatement,
  retainProposalEvidenceStatement,
  type EntityProposalRow,
} from "./entity-admission-repository";
import { documentStorage } from "./reconciliation-document";
import type { VerifiedPrintingImage } from "./reconciliation-images";

type ScryfallSourceAdmissionEvidence = {
  observation_type: "source_admission_evidence";
  game: "magic";
  source_lineage: "scryfall-magic-en";
  locator: string;
  declared_finishes: ("nonfoil" | "foil" | "etched")[];
  issues: { code: "logical_parts_unresolved" | "category_unresolved"; source_paths: string[] }[];
  appearance_evidence: {
    images: { role: "front" | "back"; source_url: string; artwork_fingerprint: string; content_sha256?: string }[];
  };
  source_sidecar: { source_record_json: string };
  completeness: {
    structurally_complete: true;
    required_surfaces_complete: true;
    partitions_complete: true;
    declared_record_count: 1;
    parsed_record_count: 1;
  };
};
type PokemonSourceAdmissionEvidence = {
  observation_type: "source_admission_evidence";
  game: "pokemon";
  source_lineage: "tcgdex-pokemon-en";
  locator: string;
  source_membership: { set_id: string; local_id: string };
  target: { kind: "unresolved_record" };
  issues: {
    code: "category_unresolved" | "card_identity_unresolved" | "printing_treatment_unresolved";
    source_paths: string[];
  }[];
  appearance_evidence: {
    images: {
      association: "source_record";
      role: "front" | "back";
      source_url: string;
      artwork_fingerprint: string;
      content_sha256?: string;
    }[];
  };
  source_sidecar: { source_record_json: string };
  completeness: ScryfallSourceAdmissionEvidence["completeness"];
};
export type SourceAdmissionEvidence = ScryfallSourceAdmissionEvidence | PokemonSourceAdmissionEvidence;
export type NormalizedSourceAdmissionEvidence = {
  kind: "source_admission_evidence";
  sourceObservationId: string;
  locator: string;
  proposalIds: string[];
};

/** Retained review evidence is validated independently of HTTP and Card/Printing contracts. */
export function parseSourceAdmissionEvidence(
  value: unknown,
  adapter: SourceAdapterRegistration,
): SourceAdmissionEvidence {
  const result = decodeDocument<SourceAdmissionEvidence>(
    "sourceAdmissionEvidence",
    value,
    "Review-required source evidence is malformed.",
  );
  for (const image of result.appearance_evidence.images) new URL(image.source_url);
  if (
    result.game !== adapter.supportedGame ||
    result.source_lineage !== adapter.sourceLineage ||
    new Set(result.appearance_evidence.images.map((image) => image.role)).size !==
      result.appearance_evidence.images.length
  )
    throw new Error("Review-required source evidence conflicts with its declared scope or roles.");
  if (result.game === "pokemon") {
    if (result.locator !== `${result.source_membership.set_id}-${result.source_membership.local_id}`)
      throw new Error("Pokémon review evidence conflicts with its exact source membership.");
    for (const image of result.appearance_evidence.images) {
      const url = new URL(image.source_url);
      if (
        url.origin !== "https://assets.tcgdex.net" ||
        !url.pathname.startsWith("/en/") ||
        !url.pathname.endsWith("/high.png") ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        url.href !== image.source_url
      )
        throw new Error("Pokémon review image is outside its exact English source surface.");
    }
  }
  return result;
}

/** Retain source-specific proposals with all evidence before acknowledging them. */
export async function retainSourceAdmissionEvidence(
  database: CatalogueStore,
  runId: string,
  observation: SourceAdmissionEvidence,
  source: { sourceObservationId: string; sourceObservationSetId: string; sourceSnapshotId: string },
  images: ReadonlyMap<string, VerifiedPrintingImage & { content_object_key: string }>,
  at: string,
): Promise<NormalizedSourceAdmissionEvidence> {
  const attributedImages = observation.appearance_evidence.images.map((image) => {
    const retained = images.get(image.source_url);
    if (image.content_sha256 !== undefined && image.content_sha256 !== retained?.content_sha256)
      throw new Error("Review-required image digest conflicts with retained evidence.");
    return { ...image, ...(retained ?? {}) };
  });
  const sourceEvidence = {
    source_snapshot_id: source.sourceSnapshotId,
    source_observation_set_id: source.sourceObservationSetId,
    source_observation_id: source.sourceObservationId,
    issues: observation.issues,
  };
  const proposals =
    observation.game === "magic"
      ? observation.declared_finishes.map((finish) => ({
          reference: canonicalJson([observation.locator, finish]),
          content: canonicalJson({ game: observation.game, locator: observation.locator, finish }),
          evidence: canonicalJson({ ...sourceEvidence, physical_images: attributedImages }),
        }))
      : [
          {
            reference: canonicalJson([observation.locator, observation.target]),
            content: canonicalJson({
              game: observation.game,
              locator: observation.locator,
              target: observation.target,
            }),
            evidence: canonicalJson({
              ...sourceEvidence,
              source_membership: observation.source_membership,
              source_images: attributedImages,
            }),
          },
        ];
  const proposalIds = [];
  for (const { reference, content, evidence } of proposals) {
    let proposal = await documentStorage(() =>
      proposalReferenceStatement(database, observation.source_lineage, reference).first<EntityProposalRow>(),
    );
    const exists = proposal !== null;
    if (!proposal) {
      // The full source record remains in sealed evidence. Partial content does
      // not invent a Card category, a Printing, a profile, or effective text.
      const id = `proposal_${await sha256Text(canonicalJson([observation.source_lineage, reference]))}`;
      proposal = {
        id,
        game: observation.game,
        source_lineage: observation.source_lineage,
        reference,
        content_json: content,
        evidence_json: evidence,
        idempotency_key: id,
        request_json: canonicalJson([content, evidence]),
        created_at: at,
      };
      if (new TextEncoder().encode(proposal.request_json).byteLength > 60 * 1024)
        throw new Error("Review-required proposal exceeds its bounded owner document.");
    }
    const retainedProposal = proposal;
    await documentStorage(() => {
      const writes: ReturnType<typeof retainProposalEvidenceStatement>[] = [];
      if (!exists) writes.push(insertProposalStatement(database, retainedProposal, runId));
      writes.push(
        retainProposalEvidenceStatement(
          database,
          retainedProposal.id,
          runId,
          source.sourceSnapshotId,
          source.sourceObservationId,
        ),
      );
      for (const image of images.values())
        writes.push(
          retainEvidenceObjectReferenceStatement(database, {
            objectKey: image.content_object_key,
            ownerKind: "entity_proposal",
            ownerId: retainedProposal.id,
            createdAt: at,
          }),
        );
      return database.batch(writes);
    });
    proposalIds.push(proposal.id);
  }
  return {
    kind: "source_admission_evidence",
    sourceObservationId: source.sourceObservationId,
    locator: observation.locator,
    proposalIds,
  };
}
