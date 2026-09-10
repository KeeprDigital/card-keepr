import { env, introspectWorkflow, reset, type WorkflowIntrospector } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";

const workflows = [
  env.EVIDENCE_INGESTION_WORKFLOW,
  env.EVIDENCE_HOST_WORKFLOW,
  env.RECONCILIATION_WORKFLOW,
  env.CATALOGUE_BACKUP_WORKFLOW,
];

export function installWorkflowIsolation() {
  let introspectors: WorkflowIntrospector[] = [];

  beforeEach(async () => {
    introspectors = await Promise.all(workflows.map(introspectWorkflow));
  });

  afterEach(async () => {
    try {
      await Promise.all(introspectors.map((introspector) => introspector.dispose()));
    } finally {
      introspectors = [];
      await resetTestStorage();
    }
  });
  return {
    async instanceCounts() {
      if (introspectors.length !== workflows.length) throw new Error("Workflow isolation is not active.");
      const counts = await Promise.all(introspectors.map(async (introspector) => (await introspector.get()).length));
      return { evidence: counts[0]!, host: counts[1]!, reconciliation: counts[2]!, backup: counts[3]! };
    },
  };
}

export async function resetTestStorage(): Promise<void> {
  // Idle R2 actors can retain their objects across reset. Reactivate each
  // configured bucket with a bounded read before deleting runtime storage.
  await Promise.all(
    [env.EVIDENCE_OBJECTS, env.PRINTING_IMAGES, env.CATALOGUE_EXPORTS, env.BACKUPS].map((bucket) =>
      bucket.list({ limit: 1 }),
    ),
  );
  await reset();
}
