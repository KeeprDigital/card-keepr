export class AdministrationProblem extends Error {
  constructor(status, code, message, persistOutcome = true) {
    super(message);
    this.status = status;
    this.code = code;
    this.persistOutcome = persistOutcome;
  }
}
