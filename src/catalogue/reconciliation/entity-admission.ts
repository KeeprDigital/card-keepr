import { admissionPolicyDigest } from "./entity-admission-source";
import { parseReconciliationObservation } from "./reconciliation-observation";
import {
  AdministrationProblem,
  type CatalogueStore,
  type CataloguePrinting,
  canonicalProfileAttributes,
  type ProfileWarning,
  sourceFieldWarning,
  canonicalJson,
} from "../shared";
import { sourceLineages } from "../adapters";
import {
  latestProposalIntakeStatement,
  latestAcceptedAdmissionStatement,
  type AdmissionIdentityAllocation,
  proposalSourceEvidenceStatement,
  admissionCardIdentityStatement,
  admissionEntityStatement,
  proposalsStatement,
  latestAdmissionStatement,
  admissionReplayStatement,
  proposalStatement,
  proposalReplayStatement,
  proposalHistoryStatement,
  insertProposalStatement,
  insertAdmissionDecisionStatement,
  type EntityProposalRow,
  type AdmissionDecisionRow,
} from "./entity-admission-repository";

export async function createEntityProposal(
  database: CatalogueStore,
  input: {
    game: string;
    source_lineage: string;
    reference: string;
    content: unknown;
    evidence: unknown;
    idempotency_key: string;
  },
  at: string,
) {
  if (
    !["one-piece", "fusion-world", "digimon", "gundam"].includes(input.game) ||
    (input.source_lineage !== "owner" &&
      !sourceLineages.some((s) => s.id === input.source_lineage && s.game === input.game))
  )
    throw new AdministrationProblem(
      422,
      "admission_scope_invalid",
      "Select an enabled game and its registered Source Lineage or owner intake.",
    );
  if (!record(input.content) || !record(input.evidence))
    throw new AdministrationProblem(
      422,
      "proposal_document_invalid",
      "Content and evidence must be JSON objects; incomplete facts may be retained for review.",
    );
  const requestJson = canonicalJson(input);
  if (new TextEncoder().encode(requestJson).byteLength > 64 * 1024)
    throw new AdministrationProblem(
      422,
      "proposal_too_large",
      "One proposal is limited to 64 KiB of retained content and evidence.",
    );
  const replay = await proposalReplayStatement(database, input.idempotency_key).first<EntityProposalRow>();
  if (replay) {
    if (replay.request_json !== requestJson) throw conflict();
    return inspectEntityProposal(database, replay.id);
  }
  const id = `proposal_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await insertProposalStatement(database, {
      ...input,
      id,
      content_json: canonicalJson(input.content),
      evidence_json: canonicalJson(input.evidence),
      request_json: requestJson,
      created_at: at,
    }).run();
  } catch (error) {
    if (error instanceof Error && /admission_operation_not_idle|UNIQUE constraint/.test(error.message))
      throw conflict();
    throw error;
  }
  return inspectEntityProposal(database, id);
}
export async function inspectEntityProposal(database: CatalogueStore, id: string, after = 0) {
  const proposal = await proposalStatement(database, id).first<EntityProposalRow>();
  if (!proposal)
    throw new AdministrationProblem(404, "entity_proposal_not_found", "Inspect a retained Entity Proposal.");
  const history = (await proposalHistoryStatement(database, id, after).all<AdmissionDecisionRow>()).results;
  const latest = await latestAdmissionStatement(database, id).first<AdmissionDecisionRow>();
  const revision = await latestProposalIntakeStatement(database, id).first<{ decision_json: string }>();
  const initialIntake = { content: JSON.parse(proposal.content_json), evidence: JSON.parse(proposal.evidence_json) };
  const intake = revision ? JSON.parse(revision.decision_json) : initialIntake;
  return {
    id,
    game: proposal.game,
    source_lineage: proposal.source_lineage,
    reference: proposal.reference,
    content: intake.content,
    evidence: intake.evidence,
    initial_intake: initialIntake,
    status:
      latest?.action === "reconsider" || !latest ? "unresolved" : latest.action === "reject" ? "rejected" : "admitted",
    generation: latest?.generation ?? 0,
    next_history_cursor: history.length > 100 ? history[99]!.generation : null,
    history: history
      .slice(0, 100)
      .map(({ request_json: _, decision_json, ...row }) => ({ ...row, decision: JSON.parse(decision_json) })),
  };
}
export async function decideEntityProposal(
  database: CatalogueStore,
  id: string,
  input: {
    action: string;
    expected_generation: string;
    rationale: string;
    idempotency_key: string;
    exception?: unknown;
    card_id?: string;
    printing_id?: string;
    content?: unknown;
    evidence?: unknown;
  },
  at: string,
) {
  const proposal = await inspectEntityProposal(database, id);
  const requestJson = canonicalJson({ id, ...input });
  const replay = await admissionReplayStatement(database, input.idempotency_key).first<AdmissionDecisionRow>();
  if (replay) {
    if (replay.request_json !== requestJson) throw conflict();
    return proposal;
  }
  if (
    !/^(0|[1-9]\d*)$/.test(input.expected_generation) ||
    Number(input.expected_generation) !== proposal.generation ||
    !["admit", "link", "reject", "reconsider"].includes(input.action) ||
    (proposal.status === "admitted" && input.action !== "reconsider")
  )
    throw conflict();
  let decision: Record<string, unknown> = {};
  let allocations: AdmissionIdentityAllocation[] = [];
  if (input.action === "reconsider") {
    const content = input.content ?? proposal.content;
    const evidence = input.evidence ?? proposal.evidence;
    if (
      !record(content) ||
      !record(evidence) ||
      new TextEncoder().encode(canonicalJson({ content, evidence })).byteLength > 64 * 1024
    )
      throw new AdministrationProblem(
        422,
        "proposal_document_invalid",
        "Reconsideration retains a complete intake object of at most 64 KiB.",
      );
    decision = { content, evidence };
  } else if (input.content !== undefined || input.evidence !== undefined) {
    throw new AdministrationProblem(
      422,
      "admission_intake_requires_reconsideration",
      "Append revised intake through an explicit reconsideration before admitting it.",
    );
  }
  if (input.action === "admit" || input.action === "link") {
    if (proposal.status === "rejected") throw conflict();
    const validated = await validateAdmission(database, proposal, input);
    decision = validated.decision;
    allocations = validated.allocations;
  }
  try {
    await insertAdmissionDecisionStatement(
      database,
      {
        proposal_id: id,
        generation: proposal.generation + 1,
        action: input.action,
        actor: "owner",
        rationale: input.rationale,
        decision_json: canonicalJson(decision),
        idempotency_key: input.idempotency_key,
        request_json: requestJson,
        decided_at: at,
      },
      undefined,
      allocations,
    ).run();
  } catch {
    throw conflict();
  }
  return inspectEntityProposal(database, id);
}
function conflict() {
  return new AdministrationProblem(
    409,
    "entity_admission_conflict",
    "Inspect the current proposal and generation; owner decisions require idle collection, release and recovery operations.",
  );
}

async function validateAdmission(
  database: CatalogueStore,
  proposal: Awaited<ReturnType<typeof inspectEntityProposal>>,
  input: { action: string; exception?: unknown; card_id?: string; printing_id?: string },
) {
  const exception = input.exception;
  if (
    exception !== undefined &&
    (!record(exception) ||
      Object.keys(exception).some((key) => !["scope", "attestation"].includes(key)) ||
      !Array.isArray(exception.scope) ||
      exception.scope.length === 0 ||
      exception.scope.some((scope: unknown) => scope !== "source_evidence" && scope !== "identity") ||
      typeof exception.attestation !== "string" ||
      !exception.attestation.trim())
  )
    throw new AdministrationProblem(
      422,
      "admission_exception_invalid",
      "An exception must name source_evidence or identity and retain the owner's specific attestation.",
    );
  const evidence = proposal.evidence;
  const retainedSourceEvidence = await proposalSourceEvidenceStatement(database, proposal.id, "").first();
  if (
    !record(evidence) ||
    (!retainedSourceEvidence &&
      !(typeof evidence.attestation === "string" && evidence.attestation.trim()) &&
      !(record(exception) && (exception.scope as string[]).includes("source_evidence")))
  )
    throw new AdministrationProblem(
      422,
      "admission_evidence_required",
      "Retain the owner's evidence of a real Card, or a scoped source-evidence exception with personal attestation.",
    );
  let parsed: ReturnType<typeof parseReconciliationObservation>;
  const printingWarnings: ProfileWarning[] = [];
  try {
    const { printing: rawPrinting, ...cardContent } = proposal.content;
    parsed = parseReconciliationObservation(proposal.id, {
      memberships: { products: [], distribution_contexts: [], source_buckets: [] },
      ...cardContent,
    });
    if (
      parsed.kind === "card_printing" &&
      parsed.observedCardAndPrinting.card &&
      rawPrinting !== undefined &&
      rawPrinting !== null
    ) {
      if (
        !(retainedSourceEvidence && evidence.demonstrably_novel === true && evidence.novelty_proof_complete === true) &&
        (!record(exception) || !(exception.scope as string[]).includes("identity"))
      )
        throw new Error("Manual Printing admission needs an explicit identity attestation.");
      const printing = validatePrinting(
        proposal.id,
        rawPrinting,
        parsed.observedCardAndPrinting.card.game_data.profile,
        printingWarnings,
      );
      parsed = { ...parsed, observedCardAndPrinting: { ...parsed.observedCardAndPrinting, printing } };
    }
    if (
      parsed.kind !== "card_printing" ||
      !parsed.observedCardAndPrinting.card ||
      parsed.observedCardAndPrinting.card.game !== proposal.game
    )
      throw new Error("Admission requires an identified Card in the proposal's game.");
  } catch (error) {
    throw new AdministrationProblem(
      422,
      "admission_structure_invalid",
      error instanceof Error ? error.message : "Invalid required structure.",
    );
  }
  const { card, printing } = parsed.observedCardAndPrinting;
  const previousRow = await latestAcceptedAdmissionStatement(database, proposal.id).first<AdmissionDecisionRow>();
  const previous = previousRow
    ? (JSON.parse(previousRow.decision_json) as {
        card: { id: string; official_identity: unknown };
        printing: { id: string } | null;
      })
    : null;
  if (previous && canonicalJson(previous.card.official_identity) !== canonicalJson(card!.official_identity))
    throw new AdministrationProblem(
      422,
      "admission_identity_correction_required",
      "An established identity cannot change through admission reconsideration. Use the identity correction process.",
    );
  if (card!.official_identity.kind !== "unknown" && input.action === "admit" && !input.card_id && !previous) {
    const matches = (
      await admissionCardIdentityStatement(database, proposal.game, canonicalJson(card!.official_identity)).all<{
        id: string;
      }>()
    ).results;
    if (matches.length > 0)
      throw new AdministrationProblem(
        422,
        "admission_identity_already_exists",
        "This Card identity already exists. Link evidence, or identify its Card when admitting a new Printing.",
      );
  }
  let cardId = input.card_id ?? previous?.card.id;
  const printingId = input.printing_id ?? previous?.printing?.id;
  if (input.action === "link" && !cardId && !printingId)
    throw new AdministrationProblem(422, "admission_link_required", "Link to an existing Card or Printing ID.");
  if (printingId && !printing)
    throw new AdministrationProblem(
      422,
      "admission_link_invalid",
      "Linking a Printing requires its valid required structure and identified Card.",
    );
  if (input.printing_id) {
    const existing = await admissionEntityStatement(database, "printing", printingId!).first<{
      document_json: string;
    }>();
    if (!existing)
      throw new AdministrationProblem(
        422,
        "admission_link_invalid",
        "The linked Printing must exist in the current catalogue.",
      );
    const document = JSON.parse(existing.document_json);
    const target = document.data ?? document;
    if (cardId && cardId !== target.card_id)
      throw new AdministrationProblem(422, "admission_link_invalid", "The Printing's Card relationship must agree.");
    cardId = target.card_id;
  }
  if (input.card_id || input.printing_id) {
    const existing = await admissionEntityStatement(database, "card", cardId!).first<{ document_json: string }>();
    if (!existing)
      throw new AdministrationProblem(
        422,
        "admission_link_invalid",
        "The linked Card must exist in the current catalogue.",
      );
    const document = JSON.parse(existing.document_json);
    const target = document.data ?? document;
    if (
      target.game !== proposal.game ||
      (card!.official_identity.kind !== "unknown" &&
        canonicalJson(target.official_identity) !== canonicalJson(card!.official_identity))
    )
      throw new AdministrationProblem(
        422,
        "admission_link_invalid",
        "A linked Card must belong to the proposal's game.",
      );
  }
  cardId ??= `card_${crypto.randomUUID().replaceAll("-", "")}`;
  const decision = {
    card: { ...card, id: cardId },
    printing: printing
      ? { ...printing, id: printingId ?? `printing_${crypto.randomUUID().replaceAll("-", "")}`, card_id: cardId }
      : null,
    exception: exception ?? null,
    warnings: [...parsed.sourceWarnings, ...printingWarnings],
    policy_digest: await admissionPolicyDigest(proposal.source_lineage, card!.game_data.profile),
    publisher_confirmed_fields: [],
    new_card: !input.card_id && !input.printing_id && !previous,
    linked: input.action === "link",
  };
  const allocations: AdmissionIdentityAllocation[] = [];
  if (decision.new_card)
    allocations.push({
      kind: "card",
      id: cardId,
      key: canonicalJson([
        "card",
        card!.official_identity.kind === "unknown" ? ["owner", proposal.id] : [card!.game, card!.official_identity],
      ]),
    });
  if (decision.printing && !printingId)
    allocations.push({
      kind: "printing",
      id: decision.printing.id,
      key: canonicalJson(["printing", ["owner", proposal.id]]),
    });
  return { decision, allocations };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePrinting(
  id: string,
  value: unknown,
  profile: string,
  warnings: ProfileWarning[],
): Omit<CataloguePrinting, "id" | "card_id"> {
  if (
    !record(value) ||
    !record(value.rarity) ||
    !record(value.game_data) ||
    value.game_data.profile !== profile ||
    !record(value.game_data.attributes)
  )
    throw new Error("Printing requires rarity and the Card's Game Profile structure.");
  for (const [object, known, path] of [
    [value, ["rarity", "printed_rules_text", "game_data"], "printing"],
    [value.rarity, ["raw", "normalized"], "printing.rarity"],
    [value.game_data, ["profile", "attributes"], "printing.game_data"],
  ] as const) {
    for (const [field, raw] of Object.entries(object))
      if (!(known as readonly string[]).includes(field))
        warnings.push(sourceFieldWarning(id, profile, `${path}.${field}`, raw));
  }
  const nullableText = (value: unknown) => {
    if (value === null || typeof value === "string") return value;
    throw new Error("Printing text and rarity must be strings or explicit unknown nulls.");
  };
  return {
    rarity: { raw: nullableText(value.rarity.raw), normalized: nullableText(value.rarity.normalized) },
    printed_rules_text: nullableText(value.printed_rules_text),
    game_data: {
      profile: profile as NonNullable<CataloguePrinting["game_data"]>["profile"],
      attributes: canonicalProfileAttributes(id, profile, "printing", value.game_data.attributes, warnings),
    },
  };
}

export async function listEntityProposals(database: CatalogueStore, game: string, after: string) {
  const rows = (await proposalsStatement(database, game, after).all<{ id: string }>()).results;
  return {
    proposals: await Promise.all(
      rows.slice(0, 100).map(async (row) => {
        const p = await inspectEntityProposal(database, row.id);
        return {
          id: p.id,
          game: p.game,
          source_lineage: p.source_lineage,
          reference: p.reference,
          generation: p.generation,
          status: p.status,
        };
      }),
    ),
    next_cursor: rows.length > 100 ? rows[99]!.id : null,
  };
}

export async function inspectProposalSourceEvidence(database: CatalogueStore, id: string, after: string) {
  await inspectEntityProposal(database, id);
  const rows = (await proposalSourceEvidenceStatement(database, id, after).all<{ source_observation_id: string }>())
    .results;
  return { evidence: rows.slice(0, 100), next_cursor: rows.length > 100 ? rows[99]!.source_observation_id : null };
}
