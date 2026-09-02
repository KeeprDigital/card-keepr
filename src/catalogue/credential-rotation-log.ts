import { AdministrationProblem } from "./administration-problem.ts";
import { canonicalJson, sha256, utf8 } from "./serialization";
import { assertIdentifier } from "./source-evidence-model";

// The two bearer keys each worker accepts in primary-plus-replacement form
// (ADR 0005). Provider-side credentials are rotated by runbook steps and are
// neither observed nor logged by the worker.
export const rotatableCredentialClasses = Object.freeze([
  "api_bearer_key",
  "ingestion_admin_key",
] as const);

export type RotatableCredentialClass =
  (typeof rotatableCredentialClasses)[number];

export const credentialRotationLogEntryContract =
  "card-keepr-credential-rotation-log-entry@1" as const;
export const credentialRotationLogContract =
  "card-keepr-credential-rotation-log@1" as const;

const maximumOperatorNoteLength = 500;

export type CredentialRotationLogEntry = Readonly<{
  contract: typeof credentialRotationLogEntryContract;
  sequence: number;
  credential_class: RotatableCredentialClass;
  operator_note: string;
  recorded_at: string;
  idempotency_key: string;
}>;

export type CredentialRotationLogRequest = Readonly<{
  credential_class: unknown;
  operator_note: unknown;
  idempotency_key: string;
}>;

type LogRow = {
  sequence: number;
  credential_class: RotatableCredentialClass;
  operator_note: string;
  recorded_at: string;
  idempotency_key: string;
  request_digest: string;
};

// Append one rotation to the immutable log. Idempotent on the caller's key:
// a replay with the same content returns the original entry and appends
// nothing, while the same key with different content is an explicit
// conflict rather than a silent second entry.
export async function appendCredentialRotationLogEntry(
  database: D1Database,
  request: CredentialRotationLogRequest,
  recordedAt: string,
): Promise<{ entry: CredentialRotationLogEntry; created: boolean }> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const credentialClass = requiredCredentialClass(request.credential_class);
  const operatorNote = requiredOperatorNote(request.operator_note);
  const requestDigest = await sha256(utf8(canonicalJson({
    credential_class: credentialClass,
    operator_note: operatorNote,
    idempotency_key: request.idempotency_key,
  })));
  const replayed = await retainedEntry(
    database,
    request.idempotency_key,
    requestDigest,
  );
  if (replayed !== null) return { entry: replayed, created: false };
  const inserted = await database
    .prepare(
      `INSERT INTO credential_rotation_log (
         credential_class, operator_note, recorded_at, idempotency_key,
         request_digest
       ) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING sequence, credential_class, operator_note, recorded_at,
                 idempotency_key, request_digest`,
    )
    .bind(
      credentialClass,
      operatorNote,
      recordedAt,
      request.idempotency_key,
      requestDigest,
    )
    .first<LogRow>();
  if (inserted !== null) return { entry: entryFromRow(inserted), created: true };
  // A concurrent append under the same key won the insert; report its
  // retained entry (or its conflict) exactly as a later replay would.
  const raced = await retainedEntry(
    database,
    request.idempotency_key,
    requestDigest,
  );
  if (raced === null) {
    throw new Error("The credential rotation log entry could not be retained.");
  }
  return { entry: raced, created: false };
}

export async function listCredentialRotationLogEntries(
  database: D1Database,
): Promise<{
  contract: typeof credentialRotationLogContract;
  entries: CredentialRotationLogEntry[];
}> {
  const rows = await database
    .prepare(
      `SELECT sequence, credential_class, operator_note, recorded_at,
              idempotency_key, request_digest
       FROM credential_rotation_log
       ORDER BY sequence`,
    )
    .all<LogRow>();
  return {
    contract: credentialRotationLogContract,
    entries: rows.results.map(entryFromRow),
  };
}

async function retainedEntry(
  database: D1Database,
  idempotencyKey: string,
  requestDigest: string,
): Promise<CredentialRotationLogEntry | null> {
  const retained = await database
    .prepare(
      `SELECT sequence, credential_class, operator_note, recorded_at,
              idempotency_key, request_digest
       FROM credential_rotation_log
       WHERE idempotency_key = ?`,
    )
    .bind(idempotencyKey)
    .first<LogRow>();
  if (retained === null) return null;
  if (retained.request_digest !== requestDigest) {
    throw new AdministrationProblem(
      409,
      "idempotency_conflict",
      "The idempotency key was already used for a different rotation log entry.",
    );
  }
  return entryFromRow(retained);
}

function entryFromRow(row: LogRow): CredentialRotationLogEntry {
  return {
    contract: credentialRotationLogEntryContract,
    sequence: row.sequence,
    credential_class: row.credential_class,
    operator_note: row.operator_note,
    recorded_at: row.recorded_at,
    idempotency_key: row.idempotency_key,
  };
}

function requiredCredentialClass(value: unknown): RotatableCredentialClass {
  const match = rotatableCredentialClasses.find((known) => known === value);
  if (match === undefined) {
    throw new AdministrationProblem(
      422,
      "credential_class_invalid",
      `credential_class must be one of ${rotatableCredentialClasses.join(", ")}.`,
    );
  }
  return match;
}

function requiredOperatorNote(value: unknown): string {
  if (typeof value !== "string") {
    throw new AdministrationProblem(
      422,
      "operator_note_invalid",
      "operator_note must be a string.",
    );
  }
  const note = value.normalize("NFC").trim();
  if (note.length === 0 || note.length > maximumOperatorNoteLength) {
    throw new AdministrationProblem(
      422,
      "operator_note_invalid",
      `operator_note must be between 1 and ${maximumOperatorNoteLength} characters.`,
    );
  }
  return note;
}
