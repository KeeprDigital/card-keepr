/** A successful durable boundary returns control to the Workflow scheduler. */
export class ReconciliationContinuation extends Error {
  constructor(
    readonly checkpoint: {
      phase:
        | "source_graph"
        | "source_documents"
        | "normalization"
        | "input_preparation"
        | "input_verification"
        | "prior_state"
        | "initial_warnings"
        | "entity_admissions"
        | "admission_selection"
        | "identity_associations"
        | "official_reduction"
        | "official_errata"
        | "official_assembly"
        | "disappearance_warnings"
        | "withdrawal_diagnostics"
        | `product_reduction:${"one-piece" | "digimon" | "fusion-world" | "gundam"}`;
      ordinal: number;
    },
  ) {
    super("Reconciliation has retained its next work cursor.");
    this.name = "ReconciliationContinuation";
  }
}
