/** A successful durable boundary returns control to the Workflow scheduler. */
export class ReconciliationContinuation extends Error {
  constructor(
    readonly checkpoint: {
      phase:
        | "source_graph"
        | "normalization"
        | "input_preparation"
        | "input_verification"
        | "prior_state"
        | "official_reduction"
        | "official_errata"
        | "withdrawal_diagnostics";
      ordinal: number;
    },
  ) {
    super("Reconciliation has retained its next work cursor.");
    this.name = "ReconciliationContinuation";
  }
}
