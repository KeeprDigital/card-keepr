import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  correctionStatement,
  correctionReplayStatement,
  correctionStateStatement,
  correctionEntityStatement,
  correctionCardPrintingsStatement,
  correctionHistoryStatement,
  insertCorrectionStatement,
  type CorrectionRow,
} from "./identity-correction-repository";

type Proposal = {
  game: string;
  entity_kind: "card" | "printing";
  action: "merge" | "split";
  source_ids: string[];
  replacement_ids: string[];
  printing_assignments: Record<string, string>;
  expected_current_revision_id: string;
  rationale: string;
  evidence: { attestation: string };
};
function invalid(detail: string): never {
  throw new AdministrationProblem(422, "identity_correction_invalid", detail);
}
function proposal(value: Record<string, unknown>): Proposal {
  const fields = [
    "game",
    "entity_kind",
    "action",
    "source_ids",
    "replacement_ids",
    "printing_assignments",
    "expected_current_revision_id",
    "rationale",
    "evidence",
  ];
  if (Object.keys(value).some((k) => !fields.includes(k))) invalid("Unknown correction proposal field.");
  if (
    !["one-piece", "fusion-world", "digimon", "gundam"].includes(String(value.game)) ||
    !["card", "printing"].includes(String(value.entity_kind)) ||
    !["merge", "split"].includes(String(value.action))
  )
    invalid("Select a Supported Game, Card or Printing, and merge or split.");
  for (const key of ["source_ids", "replacement_ids"] as const) {
    const ids = value[key];
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    )
      invalid("Provide one to 100 distinct IDs per side.");
  }
  const sources = value.source_ids as string[],
    targets = value.replacement_ids as string[];
  if (
    sources.some((id) => targets.includes(id)) ||
    (value.action === "merge" ? targets.length !== 1 : sources.length !== 1 || targets.length < 2)
  )
    invalid(
      "A merge has one survivor; a split has one conflated identity and at least two replacements, with no self-reference.",
    );
  if (
    !value.printing_assignments ||
    typeof value.printing_assignments !== "object" ||
    Array.isArray(value.printing_assignments) ||
    Object.values(value.printing_assignments).some((id) => typeof id !== "string" || !targets.includes(id))
  )
    invalid("Printing assignments must explicitly name replacement Card IDs.");
  for (const key of ["expected_current_revision_id", "rationale"] as const)
    if (typeof value[key] !== "string" || !value[key].trim()) invalid(`${key} is required.`);
  const evidence = value.evidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).some((k) => k !== "attestation") ||
    typeof (evidence as { attestation?: unknown }).attestation !== "string" ||
    !(evidence as { attestation: string }).attestation.trim()
  )
    invalid(
      "Retain the owner's specific evidence attestation; source mapping history remains independently inspectable.",
    );
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > 64 * 1024)
    invalid("One correction is limited to 64 KiB.");
  return value as Proposal;
}
export async function validateIdentityCorrection(database: CatalogueStore, value: Record<string, unknown>) {
  const input = proposal(value);
  const state = await correctionStateStatement(database).first<{
    current_revision_id: string;
    decision_cutoff: number;
  }>();
  if (state?.current_revision_id !== input.expected_current_revision_id)
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "Review the current published Catalogue Revision.",
    );
  const entities: Record<string, Record<string, unknown>> = {};
  for (const id of [...input.source_ids, ...input.replacement_ids]) {
    const row = await correctionEntityStatement(database, input.entity_kind, id, state.current_revision_id).first<{
      document_json: string;
    }>();
    if (!row)
      invalid(
        "Every source and replacement must exist in the reviewed published revision. Admit new replacements separately first.",
      );
    const envelope = JSON.parse(row.document_json);
    const entity = envelope.data ?? envelope;
    let game = entity.game;
    if (input.entity_kind === "printing") {
      const card = await correctionEntityStatement(database, "card", entity.card_id, state.current_revision_id).first<{
        document_json: string;
      }>();
      if (!card) invalid("Printing has no published Card.");
      const document = JSON.parse(card.document_json);
      game = (document.data ?? document).game;
    }
    if (game !== input.game) invalid("All identities must belong to the correction's Supported Game.");
    entities[id] = entity;
  }
  let after = 0;
  while (true) {
    const rows = (await correctionHistoryStatement(database, input.game, after).all<CorrectionRow>()).results;
    for (const row of rows) {
      const earlier = JSON.parse(row.request_json) as Proposal;
      if ([...input.source_ids, ...input.replacement_ids].some((id) => earlier.source_ids.includes(id)))
        invalid(
          "An identity already retired by a retained decision cannot be selected again; inspect its survivor or replacements.",
        );
    }
    if (rows.length < 100) break;
    after = rows.at(-1)!.sequence;
  }
  const children =
    input.entity_kind === "card"
      ? (
          await correctionCardPrintingsStatement(database, state.current_revision_id, input.source_ids).all<{
            printing_id: string;
            card_id: string;
          }>()
        ).results
      : [];
  if (children.length > 1000) invalid("One reviewed correction is limited to 1,000 affected Printings.");
  if (input.entity_kind === "printing" && Object.keys(input.printing_assignments).length)
    invalid("Printing corrections do not take Card assignments.");
  if (
    input.entity_kind === "card" &&
    input.action === "split" &&
    (children.some((p) => !input.printing_assignments[p.printing_id]) ||
      Object.keys(input.printing_assignments).some((id) => !children.some((p) => p.printing_id === id)))
  )
    invalid(
      "Explicitly assign every affected catalogue Printing to one replacement Card; never infer a consumer's split variant.",
    );
  if (input.action === "merge" && Object.keys(input.printing_assignments).length)
    invalid("Merge uses its sole survivor; Printing assignments are only for Card splits.");
  if (
    input.entity_kind === "printing" &&
    input.action === "merge" &&
    new Set(Object.values(entities).map((e) => e.card_id)).size !== 1
  )
    invalid("Merge the Cards explicitly before merging Printings attached to different Cards.");
  const reviewed = { proposal: input, entities, children, decision_cutoff: state.decision_cutoff };
  if (new TextEncoder().encode(canonicalJson(reviewed)).byteLength > 256 * 1024)
    invalid("The reviewed evidence exceeds the 256 KiB correction record bound.");
  return { valid: true, review_digest: await sha256Text(canonicalJson(reviewed)), reviewed };
}
export async function createIdentityCorrection(database: CatalogueStore, input: Record<string, unknown>, at: string) {
  const { review_digest, idempotency_key, ...value } = input;
  if (typeof idempotency_key !== "string" || !idempotency_key.trim()) invalid("idempotency_key is required.");
  const replay = await correctionReplayStatement(database, idempotency_key).first<CorrectionRow>();
  if (replay) {
    if (replay.request_json !== canonicalJson(value) || replay.review_digest !== review_digest)
      throw new AdministrationProblem(
        409,
        "identity_correction_conflict",
        "The idempotency key already names a different reviewed decision.",
      );
    return inspectIdentityCorrection(database, replay.id);
  }
  const validation = await validateIdentityCorrection(database, value);
  if (review_digest !== validation.review_digest)
    throw new AdministrationProblem(
      409,
      "identity_correction_review_mismatch",
      "Create exactly the correction returned by validation.",
    );
  const id = `correction_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    await insertCorrectionStatement(
      database,
      {
        id,
        game: String(value.game),
        request_json: canonicalJson(value),
        reviewed_json: canonicalJson(validation.reviewed),
        review_digest: validation.review_digest,
        idempotency_key,
        decided_at: at,
      },
      String(value.expected_current_revision_id),
      validation.reviewed.decision_cutoff,
    ).run();
  } catch {
    throw new AdministrationProblem(
      409,
      "identity_correction_conflict",
      "Correction requires the reviewed current revision and idle collection, release and recovery.",
    );
  }
  return inspectIdentityCorrection(database, id);
}
export async function inspectIdentityCorrection(database: CatalogueStore, id: string) {
  const row = await correctionStatement(database, id).first<CorrectionRow>();
  if (!row)
    throw new AdministrationProblem(404, "identity_correction_not_found", "Inspect a retained correction decision.");
  return {
    id: row.id,
    sequence: row.sequence,
    ...JSON.parse(row.request_json),
    review_digest: row.review_digest,
    reviewed: JSON.parse(row.reviewed_json),
    decided_at: row.decided_at,
  };
}
export async function listIdentityCorrections(database: CatalogueStore, game: string, after: number) {
  const rows = (await correctionHistoryStatement(database, game, after).all<CorrectionRow>()).results;
  return {
    decisions: rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      ...JSON.parse(row.request_json),
      decided_at: row.decided_at,
    })),
    next_cursor: rows.length === 100 ? rows.at(-1)!.sequence : null,
  };
}
