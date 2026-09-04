// Public surface of the `legality` cluster: Legality Rules, their effect
// policy and lifecycle, their stored and exported documents, and their
// publication statements. The Legality Status read path lives in `read`.
// See ../README.md (issue #96).

export {
  assertCanonicalLegalityRule,
  canonicalLegalityRuleId,
  legalityRuleCardIds,
  parseRetainedLegalityRules,
  regionForLineage,
  resolveLegalityRuleCards,
  unresolvedTargetScope,
  type RetainedLegalityRule,
} from "./legality-rule";
export {
  evaluateLegalityRuleEffect,
  legalityExportKind,
  type LegalityEvaluation,
} from "./legality-effect-policy";
export {
  legalityRulesForCandidate,
  normalizedLegalityRuleLifecycle,
  type LegalityRuleLifecycle,
} from "./legality-rule-lifecycle";
export {
  legalityRuleExportRecords,
  legalityRuleRelationshipRecords,
} from "./legality-export";
export { legalityPublicationStatements } from "./legality-publication";
export {
  parseStoredCatalogueCard,
  parseStoredLegalityRule,
  type StoredLegalityStatusCard,
  type StoredLegalityStatusRule,
} from "./stored-legality-documents";
