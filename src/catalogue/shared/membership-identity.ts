import type { SupportedGame } from "./catalogue-candidate-types";
import { canonicalJson, sha256Text } from "./serialization";

export type MembershipRelationship = {
  source_lineage: string;
  relationship_kind: "product" | "distribution_context" | "source_bucket";
  relationship_value: string;
};

/** Membership values retain the same identities in historical and native publication. */
export async function membershipRelationshipId(
  game: SupportedGame,
  printingId: string,
  relationship: MembershipRelationship,
  targetId: string,
): Promise<string> {
  return `relationship_${await sha256Text(
    canonicalJson({
      game,
      printing_id: printingId,
      source_lineage: relationship.source_lineage,
      relationship_kind: relationship.relationship_kind,
      relationship_value: relationship.relationship_value,
      target_id: targetId,
    }),
  )}`;
}

export async function membershipDistributionContextId(
  game: SupportedGame,
  sourceLineage: string,
  label: string,
): Promise<string> {
  return `distribution_context_${await sha256Text(canonicalJson({ game, source_lineage: sourceLineage, label }))}`;
}
