export class CredentialRotationProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function credentialConflict(
  code: string,
  detail: string,
): CredentialRotationProblem {
  return new CredentialRotationProblem(409, code, detail);
}
