import { activeRunStages as stages, ingestionRunStates as states } from "./ingestion-run-state.ts";

// Persisted document shapes. Semantic relationships remain with their domain codec.
// Validators are compiled ahead of time: Workers cannot compile Ajv schemas with eval.
const string = { type: "string" };
const opaque = { ...string, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$" };
const digest = { ...string, pattern: "^[a-f0-9]{64}$" };
const nullable = (schema) => ({ anyOf: [{ type: "null" }, schema] });
const array = (items, extra = {}) => ({ type: "array", items, ...extra });
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});
const selectedGames = array({ enum: ["one-piece", "fusion-world", "digimon", "gundam"] }, { minItems: 1 });
const approval = object({
  action: { const: "approved" },
  approved_at: string,
  candidate_digest: digest,
  expected_current_revision_id: opaque,
});
const warning = {
  anyOf: [
    object({ code: { ...string, pattern: "[\\s\\S]" }, detail: string }),
    object({
      code: { ...string, pattern: "[\\s\\S]" },
      detail: string,
      severity: { enum: ["info", "warning", "error"] },
    }),
    object({
      code: { const: "curated_revision_reconfirmation_required" },
      detail: string,
      curated_revision_id: opaque,
      conflict_id: opaque,
      conflict_digest: digest,
    }),
  ],
};
const progress = object({
  completed_stages: array({ enum: stages }, { maxItems: stages.length }),
  current_stage: { enum: states },
});
const approvalHistory = array(
  { anyOf: [approval, object({ action: { const: "rejected" }, rejected_at: string, candidate_digest: digest })] },
  { maxItems: 1 },
);
const reservation = object({
  revision_id: opaque,
  started_at: string,
  reconcile_after: string,
  manifest_digest: digest,
  writer_token: string,
});
const cleanup = object({
  state: { enum: ["pending", "cleaning", "completed", "failed"] },
  attempts: { type: "integer", minimum: 0 },
  failure_code: nullable(string),
  last_attempt_at: nullable(string),
  completed_at: nullable(string),
  not_before: string,
  generation: { type: "integer", minimum: 0 },
});
const publicRunProperties = {
  id: opaque,
  state: { enum: states },
  selected_games: selectedGames,
  started_at: string,
  expected_current_revision_id: opaque,
  linked_run_id: nullable(opaque),
  idempotency_key: opaque,
  candidate_digest: nullable(digest),
  candidate_created_at: nullable(string),
  approval_deadline: nullable(string),
  approval: {},
  approval_history: {},
  progress: {},
  warnings: {},
  failure_code: nullable(string),
  publication_outcome: { enum: [null, "revision", "no_change"] },
  published_revision_id: nullable(opaque),
  resulting_revision_id: nullable(opaque),
  freshness_checked_at: nullable(string),
  terminal_at: nullable(string),
  publication_reservation: {},
  publication_cleanup: {},
};
const stringRecord = { type: "object", additionalProperties: string };
const evidenceRequest = object(
  { id: string, url: string, method: { const: "GET" }, headers: stringRecord, representation_fingerprint: string },
  undefined,
  true,
);
const nonempty = { ...string, pattern: "[\\s\\S]" };
const game = { enum: ["one-piece", "fusion-world", "digimon", "gundam"] };
const record = { type: "object" };
const curatedFieldTarget = object({
  kind: { const: "field" },
  entity_type: { enum: ["card", "printing", "product", "release", "distribution_context", "erratum"] },
  entity_id: opaque,
  path: { ...string, pattern: "^/" },
});
const endpoint = (type) => object({ type: { const: type }, id: opaque });
const curatedTarget = {
  anyOf: [
    curatedFieldTarget,
    ...[
      ["printing-product", "printing", "product"],
      ["printing-distribution-context", "printing", "distribution_context"],
      ["distribution-context-product", "distribution_context", "product"],
      ["product-card", "product", "card"],
    ].map(([kind, from, to]) =>
      object({
        kind: { const: "relationship" },
        relationship_kind: { const: kind },
        from: endpoint(from),
        to: endpoint(to),
      }),
    ),
  ],
};
const curatedEvidence = {
  anyOf: [
    object({ kind: { const: "source_observation" }, id: opaque }),
    object({ kind: { const: "owner_reference" }, uri: string, content_digest: digest }),
  ],
};
const curatedProvenance = object({
  curated_revision_id: opaque,
  content_digest: digest,
  target: curatedTarget,
  rationale: nonempty,
  evidence: array(curatedEvidence, { minItems: 1 }),
  author: nonempty,
  reviewed_source_value: {},
});
const gameData = object({ profile: string, attributes: record });
const card = object(
  {
    id: string,
    game,
    official_identity: {
      anyOf: [
        object({ kind: { const: "card_number" }, value: nonempty }),
        object({ kind: { const: "functional_designation" }, value: { const: "DON!!" } }),
      ],
    },
    name: string,
    effective_rules_text: nullable(string),
    game_data: gameData,
    curated_provenance: array(curatedProvenance),
  },
  ["id", "game", "official_identity", "name", "effective_rules_text", "game_data"],
);
const printing = object(
  {
    id: string,
    card_id: string,
    rarity: object({ normalized: nullable(string), raw: nullable(string) }),
    printed_rules_text: nullable(string),
    game_data: nullable(gameData),
    curated_provenance: array(curatedProvenance),
  },
  ["id", "card_id", "rarity", "printed_rules_text", "game_data"],
);
const erratum = object(
  {
    id: string,
    game,
    target_type: { enum: ["card", "printing"] },
    target_id: string,
    effective_from: nullable(string),
    official_wording: string,
    corrected_value: nullable(string),
    provenance: array(object({ source_lineage: string, source_observation_id: string })),
    curated_provenance: array(curatedProvenance, { minItems: 1 }),
  },
  ["id", "game", "target_type", "target_id", "effective_from", "official_wording", "corrected_value", "provenance"],
);
const candidate = object(
  {
    contract: { const: "card-keepr-catalogue-candidate@1" },
    selected_games: selectedGames,
    cards: array(card),
    printings: array(printing),
    printing_images: {},
    products: array(record),
    distribution_contexts: array(record),
    product_relationships: array(record),
    card_observed_games: array(game),
    product_observed_games: array(game),
    product_observed_lineages: array(nonempty),
    source_checks: array({}),
    errata: array(erratum),
  },
  ["contract", "selected_games", "cards", "printings"],
);
// Proposal identities historically have no storage-identity length ceiling.
const proposalIdentity = { ...string, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const proposalEvidence = array(
  {
    anyOf: [
      object({ kind: { const: "source_observation" }, id: proposalIdentity }),
      object({ kind: { const: "owner_reference" }, uri: string, content_digest: digest }),
    ],
  },
  { minItems: 1 },
);
const proposalFieldTarget = {
  ...curatedFieldTarget,
  properties: { ...curatedFieldTarget.properties, entity_id: proposalIdentity },
};
export const documentSchemas = {
  record,
  candidate,
  proposalEvidence,
  proposalFieldTarget,
  selectedGames,
  progress,
  warnings: array(warning),
  approval,
  approvalHistory,
  cleanupKeys: array(string, { uniqueItems: true }),
  reservation,
  cleanup,
  publicRun: object(
    { ...publicRunProperties, export_manifest_digest: digest, operational_diagnostics: {} },
    Object.keys(publicRunProperties),
  ),
  stringRecord,
  evidencePlan: object(
    {
      supported_game: string,
      source_lineage: string,
      game_profile_version: string,
      adapter_version: string,
      requests: array(evidenceRequest),
    },
    undefined,
    true,
  ),
};
