import { backupRecoveryRoutes } from "../backup-recovery";
import { curatedRoutes } from "../curated";
import { exportRoutes } from "../export";
import { reconciliationRoutes } from "../reconciliation";
import { sourceEvidenceRoutes } from "../source-evidence";
import { ingestionRoutes } from "./routes";

/** The Worker and contract generator consume this exact administration composition. */
export const administrationRouteFamilies = {
  ingestion: ingestionRoutes,
  "source-evidence": sourceEvidenceRoutes,
  reconciliation: reconciliationRoutes,
  curated: curatedRoutes,
  export: exportRoutes,
  "backup-recovery": backupRecoveryRoutes,
};
export const administrationRoutes = Object.values(administrationRouteFamilies).flat();
