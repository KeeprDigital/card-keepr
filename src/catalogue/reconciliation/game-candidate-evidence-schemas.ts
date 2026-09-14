import { z } from "@hono/zod-openapi";
import { digest, identifier } from "../../http/openapi";
import {
  cardRecord,
  observedCard,
  observedPrinting,
  historicalObservedCard,
  historicalObservedPrinting,
  printingRecord,
  historicalCard,
  historicalPrinting,
  candidateWarning,
  curatedEvidence,
  curatedTarget,
  sourceValue,
} from "./game-candidate-record-schemas";
const count = z.number().int().nonnegative();
const text = z.string().nullable();
const correctionRequest = z.strictObject({
  game: identifier,
  entity_kind: z.enum(["card", "printing"]),
  action: z.enum(["merge", "split", "assign"]),
  source_ids: z.array(identifier),
  replacement_ids: z.array(identifier),
  printing_assignments: z.record(identifier, identifier),
  expected_current_revision_id: identifier,
  rationale: text,
  evidence: z.strictObject({ attestation: text }),
});
const curatedProposal = z.strictObject({
  game: identifier,
  target: curatedTarget,
  assertion: z.union([
    z.strictObject({ kind: z.literal("field"), value: sourceValue }),
    z.strictObject({ kind: z.literal("relationship"), presence: z.enum(["present", "absent"]) }),
  ]),
  rationale: text,
  evidence: curatedEvidence,
  effective_interval: z.strictObject({ from: text, to: text }),
  reviewed_source_digest: digest,
  supersedes_revision_id: identifier.nullable(),
});
const admissionDecision = (
  card: typeof cardRecord | typeof historicalCard,
  printing: typeof printingRecord | typeof historicalPrinting,
) =>
  z.strictObject({
    card,
    printing: z.union([printing, z.null()]),
    linked: z.boolean(),
    warnings: z.array(candidateWarning),
    exception: z
      .strictObject({ scope: z.array(z.enum(["source_evidence", "identity"])), attestation: text })
      .nullable(),
    policy_digest: digest,
    publisher_confirmed_fields: z.array(z.string()),
    new_card: z.boolean().optional(),
  });
const admission = z.union([
  admissionDecision(cardRecord, printingRecord),
  admissionDecision(historicalCard, historicalPrinting),
  z.strictObject({ content: z.record(z.string(), sourceValue), evidence: z.record(z.string(), sourceValue) }),
  z.strictObject({}),
]);
const compatibility = z.strictObject({
  card_id: identifier,
  source_lineage: identifier,
  artwork_fingerprint: text,
  printed_fields_digest: text,
  rarity_normalized: text,
  treatment: text,
});
const mappingEvidence = z.union([
  z.strictObject({
    card: z.union([observedCard, z.null()]),
    printing: z.union([observedPrinting, z.null()]),
    compatibility: compatibility.nullable(),
    publisher_confirmation: z.strictObject({ fields: z.array(z.string()) }).nullable(),
  }),
  z.strictObject({
    card: z.union([historicalObservedCard, z.null()]),
    printing: z.union([historicalObservedPrinting, z.null()]),
    compatibility: compatibility.nullable(),
    publisher_confirmation: z.strictObject({ fields: z.array(z.string()) }).nullable(),
  }),
  z.strictObject({
    compatibility: compatibility.nullable(),
    retained_evidence: z.strictObject({
      source_observation_id: identifier,
      source_observation_set_id: identifier,
      source_snapshot_id: identifier,
      content_digest: digest,
    }),
  }),
]);
const evidence = {
  identity: z.strictObject({
    entity_id: identifier,
    entity_kind: z.enum(["card", "printing"]),
    source_lineage: identifier,
    ingestion_run_id: identifier,
    source_snapshot_id: identifier,
    source_observation_set_id: identifier,
    source_observation_id: identifier,
    locator: text,
    variant_key: text,
    evidence: mappingEvidence,
    mapped_at: text,
  }),
  admission: z.strictObject({
    proposal_id: identifier,
    source_lineage: identifier,
    generation: count,
    action: z.enum(["admit", "link", "reject", "reconsider"]).nullable(),
    decision: admission.nullable(),
    rationale: text.optional(),
  }),
  correction: z.strictObject({
    id: identifier,
    sequence: count,
    request: correctionRequest,
    reviewed: z.union([
      z.strictObject({
        proposal: correctionRequest,
        decision_cutoff: count,
        entities: z.record(identifier, z.record(z.string(), sourceValue)),
        children: z.array(z.strictObject({ printing_id: identifier, card_id: identifier })).max(1000),
      }),
      z.strictObject({
        proposal: correctionRequest,
        decision_cutoff: count,
        split_id: identifier,
        target: z.record(z.string(), sourceValue),
        assignment_evidence: z
          .array(
            z.strictObject({
              printing_id: identifier,
              preparation_id: identifier.optional(),
              source_observation_id: identifier,
              source_snapshot_id: identifier,
              evidence: mappingEvidence,
            }),
          )
          .max(100),
      }),
    ]),
    review_digest: digest,
    decided_at: text,
  }),
  curated: z.strictObject({
    id: identifier,
    proposal: curatedProposal,
    content_digest: digest,
    reviewed_source_digest: digest,
    active: z
      .union([z.literal(0), z.literal(1)])
      .nullable()
      .optional(),
  }),
};
export const candidateEvidenceSchema = z
  .union(
    Object.entries(evidence).map(([kind, schema]) =>
      z.strictObject({
        contract: z.literal("card-keepr-candidate-evidence@1"),
        candidate_id: identifier,
        manifest_digest: digest,
        expected_game_revision_id: identifier,
        evidence_class: z.literal(kind),
        records: z.array(schema).max(1),
        next_cursor: z.string().nullable(),
      }),
    ),
  )
  .openapi("GameCandidateEvidence");
