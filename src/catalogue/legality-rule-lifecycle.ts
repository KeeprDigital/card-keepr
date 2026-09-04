import { type CatalogueCandidate, type LegalityRule, canonicalJson, compareUtf8 } from "./shared";

export type LegalityRuleLifecycle = {
  first_revision_id: string;
  last_observed_revision_id: string;
  current: boolean;
  last_missing_revision_id: string | null;
};

export function normalizedLegalityRuleLifecycle(
  rule: Pick<LegalityRule, "first_revision_id" | "last_observed_revision_id" | "current" | "last_missing_revision_id">,
  revisionId: string,
): LegalityRuleLifecycle {
  const current = rule.current ?? true;
  return {
    first_revision_id: rule.first_revision_id ?? revisionId,
    last_observed_revision_id: rule.last_observed_revision_id ?? revisionId,
    current,
    last_missing_revision_id: current
      ? (rule.last_missing_revision_id ?? null)
      : (rule.last_missing_revision_id ?? revisionId),
  };
}

export function legalityRulesForCandidate(
  prior: CatalogueCandidate | null,
  sourceLineage: string,
  incoming: readonly LegalityRule[],
): LegalityRule[] {
  assertUniqueRuleIds(prior?.legality_rules ?? []);
  assertUniqueRuleIds(incoming);
  const priorById = new Map((prior?.legality_rules ?? []).map((rule) => [rule.id, rule]));
  const observed = incoming.map((rule) => {
    const { last_observed_revision_id: _incomingLastObservedRevisionId, ...freshRule } = rule;
    const priorRule = priorById.get(rule.id);
    if (
      priorRule !== undefined &&
      canonicalJson(identityBoundSemantics(priorRule)) !== canonicalJson(identityBoundSemantics(rule))
    ) {
      throw new Error(
        `Legality Rule official identity ${rule.official_id} has changed semantics; the Official Source must publish a new official identity.`,
      );
    }
    const firstRevisionId = rule.first_revision_id ?? priorRule?.first_revision_id;
    return {
      ...freshRule,
      ...(firstRevisionId === undefined ? {} : { first_revision_id: firstRevisionId }),
      current: true,
      last_missing_revision_id: priorRule?.last_missing_revision_id ?? null,
    };
  });
  return [
    ...(prior?.legality_rules ?? []).flatMap((rule) => {
      if (rule.source_lineage !== sourceLineage) return [rule];
      if (incoming.some((incomingRule) => incomingRule.id === rule.id)) return [];
      return [{ ...rule, current: false, last_missing_revision_id: null }];
    }),
    ...observed,
  ].sort((left, right) => compareUtf8(left.id, right.id));
}

function identityBoundSemantics(rule: LegalityRule): unknown {
  return {
    official_id: rule.official_id,
    game: rule.game,
    region: rule.region,
    format: rule.format,
    event_tier: rule.event_tier,
    effective_from: rule.effective_from,
    effective_until: rule.effective_until,
    unresolved_scope: rule.unresolved_scope,
    card_ids: [...rule.card_ids].sort(compareUtf8),
    official_wording: rule.official_wording,
    effect: rule.effect,
    source_lineage: rule.source_lineage,
  };
}

function assertUniqueRuleIds(rules: readonly LegalityRule[]): void {
  const identities = new Set<string>();
  for (const rule of rules) {
    if (identities.has(rule.id)) {
      throw new Error(`Duplicate Legality Rule identity ${rule.id}.`);
    }
    identities.add(rule.id);
  }
}
