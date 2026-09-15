import { z } from "zod";
import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
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

const reviewEvidence = z.strictObject({
  observation_type: z.literal("source_admission_evidence"),
  game: z.literal("magic"),
  source_lineage: z.literal("scryfall-magic-en"),
  locator: z.uuid(),
  declared_finishes: z
    .array(z.enum(["nonfoil", "foil", "etched"]))
    .min(1)
    .max(3),
  issues: z
    .array(
      z.object({
        code: z.literal("logical_parts_unresolved"),
        source_paths: z.array(z.string().min(1).max(256)).min(1).max(16),
      }),
    )
    .min(1)
    .max(3),
  appearance_evidence: z.object({
    images: z
      .array(
        z.object({
          role: z.enum(["front", "back"]),
          source_url: z.url().max(2048),
          artwork_fingerprint: z.string().min(1).max(256),
          content_sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        }),
      )
      .max(2),
  }),
  source_sidecar: z.object({ source_record_json: z.string().min(1) }),
  completeness: z.object({
    structurally_complete: z.literal(true),
    required_surfaces_complete: z.literal(true),
    partitions_complete: z.literal(true),
    declared_record_count: z.literal(1),
    parsed_record_count: z.literal(1),
  }),
});

export type SourceAdmissionEvidence = z.infer<typeof reviewEvidence>;
export type NormalizedSourceAdmissionEvidence = {
  kind: "source_admission_evidence";
  sourceObservationId: string;
  locator: string;
  proposalIds: string[];
};

/** This explicit wire contract is separate from strict Card/Printing validation. */
export function parseSourceAdmissionEvidence(
  value: unknown,
  adapter: SourceAdapterRegistration,
): SourceAdmissionEvidence {
  const result = reviewEvidence.parse(value);
  if (
    result.game !== adapter.supportedGame ||
    result.source_lineage !== adapter.sourceLineage ||
    new Set(result.declared_finishes).size !== result.declared_finishes.length ||
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
    const writes: ReturnType<typeof retainProposalEvidenceStatement>[] = [];
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
      writes.push(insertProposalStatement(database, proposal, runId));
    }
    writes.push(
      retainProposalEvidenceStatement(
        database,
        proposal.id,
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
          ownerId: proposal.id,
          createdAt: at,
        }),
      );
    await documentStorage(() => database.batch(writes));
    proposalIds.push(proposal.id);
  }
  return {
    kind: "source_admission_evidence",
    sourceObservationId: source.sourceObservationId,
    locator: observation.locator,
    proposalIds,
  };
}
