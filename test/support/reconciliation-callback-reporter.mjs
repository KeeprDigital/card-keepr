import { writeFileSync } from "node:fs";

/** Opt-in host-side sink for test metadata, independent of console interception. */
export default class ReconciliationCallbackReporter {
  #written = false;
  onTestCaseResult(testCase) {
    const report = testCase.meta().reconciliationBindingReport;
    if (report === undefined) return;
    if (this.#written) throw new Error("Expected one reconciliation callback artifact per run.");
    if (report.contract !== "card-keepr-local-reconciliation-callbacks@2")
      throw new Error("Unexpected reconciliation callback artifact contract.");
    const output = process.env.KEEPR_CALLBACK_ARTIFACT;
    if (!output) throw new Error("KEEPR_CALLBACK_ARTIFACT is required by the callback reporter.");
    // Write even when a test's subsequent budget assertion failed.
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    this.#written = true;
  }
  onTestRunEnd() {
    if (!this.#written) throw new Error("Reconciliation callback artifact was not delivered.");
  }
}
