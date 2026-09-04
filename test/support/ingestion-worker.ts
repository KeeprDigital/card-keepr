import { registerSyntheticSourceAdapters } from "./source-adapters";
registerSyntheticSourceAdapters();
export {
  default,
  CatalogueBackupWorkflow,
  EvidenceHostWorkflow,
  EvidenceIngestionWorkflow,
  OfficialSourceTransport,
  ReconciliationWorkflow,
} from "../../apps/ingestion/src/index";
