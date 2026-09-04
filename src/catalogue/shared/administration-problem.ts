export class AdministrationProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly persistOutcome: boolean;

  constructor(status: number, code: string, message: string, persistOutcome: boolean = true) {
    super(message);
    this.status = status;
    this.code = code;
    this.persistOutcome = persistOutcome;
  }
}
