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

export type SourceAdmissionEvidence = {
  observation_type: "source_admission_evidence";
  game: "magic";
  source_lineage: "scryfall-magic-en";
  locator: string;
  declared_finishes: ("nonfoil" | "foil" | "etched")[];
  issues: { code: "logical_parts_unresolved"; source_paths: string[] }[];
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
  return result;
}

/** Retain one ordinary locator/finish proposal with all evidence before acknowledging it. */
export async function retainSourceAdmissionEvidence(
  database: CatalogueStore,
  runId: string,
  observation: SourceAdmissionEvidence,
  source: { sourceObservationId: string; sourceObservationSetId: string; sourceSnapshotId: string },
  images: ReadonlyMap<string, VerifiedPrintingImage & { content_object_key: string }>,
  at: string,
): Promise<NormalizedSourceAdmissionEvidence> {
  const physicalImages = observation.appearance_evidence.images.map((image) => {
    const retained = images.get(image.source_url);
    if (image.content_sha256 !== undefined && image.content_sha256 !== retained?.content_sha256)
      throw new Error("Review-required image digest conflicts with retained evidence.");
    return { ...image, ...(retained ?? {}) };
  });
  const proposalIds = [];
  for (const finish of observation.declared_finishes) {
    const reference = canonicalJson([observation.locator, finish]);
    let proposal = await documentStorage(() =>
      proposalReferenceStatement(database, observation.source_lineage, reference).first<EntityProposalRow>(),
    );
    const evidence = canonicalJson({
      source_snapshot_id: source.sourceSnapshotId,
      source_observation_set_id: source.sourceObservationSetId,
      source_observation_id: source.sourceObservationId,
      issues: observation.issues,
      physical_images: physicalImages,
    });
    const exists = proposal !== null;
    if (!proposal) {
      // The full source record remains in sealed evidence. Partial content does
      // not invent a Card category, a Printing, a profile, or effective text.
      const content = canonicalJson({ game: observation.game, locator: observation.locator, finish });
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
