export class AdministrationProblem extends Error {
  constructor(
    status: number,
    code: string,
    message: string,
    persistOutcome?: boolean,
  );
  readonly status: number;
  readonly code: string;
  readonly persistOutcome: boolean;
}
