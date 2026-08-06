import {
  env,
  introspectWorkflow,
  reset,
  type WorkflowIntrospector,
} from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";

const workflows = [
  env.EVIDENCE_INGESTION_WORKFLOW,
  env.EVIDENCE_HOST_WORKFLOW,
  env.RECONCILIATION_WORKFLOW,
  env.CATALOGUE_BACKUP_WORKFLOW,
];

export function installWorkflowIsolation(): void {
  let introspectors: WorkflowIntrospector[] = [];

  beforeEach(async () => {
    introspectors = await Promise.all(workflows.map(introspectWorkflow));
  });

  afterEach(async () => {
    try {
      await Promise.all(
        introspectors.map((introspector) => introspector.dispose()),
      );
    } finally {
      introspectors = [];
      await reset();
    }
  });
}
