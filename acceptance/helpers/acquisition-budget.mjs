import { fileURLToPath } from "node:url";
import budget from "../../test/support/acquisition-budget.json" with { type: "json" };
export { budget as fixtureAcquisitionBudget };
export const fixtureAcquisitionBudgetPath = fileURLToPath(
  new URL("../../test/support/acquisition-budget.json", import.meta.url),
);
