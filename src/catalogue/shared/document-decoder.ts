import {
  record,
  candidate,
  proposalEvidence,
  proposalFieldTarget,
  selectedGames,
  progress,
  warnings,
  approval,
  approvalHistory,
  cleanupKeys,
  reservation,
  cleanup,
  publicRun,
  stringRecord,
  evidencePlan,
} from "./document-validators.mjs";

const validators = {
  record,
  candidate,
  proposalEvidence,
  proposalFieldTarget,
  selectedGames,
  progress,
  warnings,
  approval,
  approvalHistory,
  cleanupKeys,
  reservation,
  cleanup,
  publicRun,
  stringRecord,
  evidencePlan,
};

export type DocumentSchema = keyof typeof validators;

/** Decode a retained JSON value without coercion, defaults, or mutation. */
export function decodeDocument<T>(schema: DocumentSchema, value: unknown, invalid: string | (() => Error)): T {
  if (!validators[schema](value)) {
    throw typeof invalid === "string" ? new Error(invalid) : invalid();
  }
  return value as T;
}
