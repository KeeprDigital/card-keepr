/** Existing durable names are a contract: templates preserve their spelling across refactors. */
export const workflowSteps = {
  parent: {
    identities: "load retained hostname Workflow identities",
    pending: "load pending evidence page {page} barrier {stage}",
    recover: "recover pending hostname workflows stage {stage}",
    record: "record hostname Workflow identities stage {stage}",
    finalize: "finalize collection barrier stage {stage}",
    wait: "await collection barrier stage {stage}",
    reconcile: "reconcile retained Official Source evidence",
  },
  child: {
    state: "read run state stage {stage}",
    pending: "{purpose} shard page {page} stage {stage}",
    collect: "collect stage {stage} batch {offset} from {cursor} pass {pass}",
    retry: "retry {request} pass {pass}",
  },
  reconciliation: {
    reconcile: "reconcile retained Card, Printing, and Erratum evidence",
    failure: "finalize exhausted reconciliation failure",
  },
  backup: {
    backup: "export, retain, restore, and verify Catalogue D1",
    failure: "finalize exhausted Catalogue backup failure",
  },
} as const;
export type WorkflowKind = keyof typeof workflowSteps;
export type WorkflowRestartTarget = { name: string; count: number; type: "do" | "sleep" | "waitForEvent" };

function parameterPattern(key: string): string {
  if (key === "purpose") return "(?:load|reload)";
  if (key === "request") return "[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}";
  return "(?:0|[1-9][0-9]*)";
}
function templatePattern(template: string): RegExp {
  const parts = template.split(/(\{[a-z]+\})/u);
  return new RegExp(
    `^${parts
      .map((part) =>
        /^\{[a-z]+\}$/u.test(part) ? parameterPattern(part.slice(1, -1)) : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      )
      .join("")}$`,
    "u",
  );
}
export function workflowStepName(template: string, parameters: Record<string, string | number> = {}): string {
  const name = template.replace(/\{([a-z]+)\}/gu, (_, key: string) => String(parameters[key]));
  if (name.length > 256 || !templatePattern(template).test(name)) throw new Error("Invalid Workflow step parameters.");
  return name;
}
export function assertWorkflowRestartTarget(kind: WorkflowKind, target: WorkflowRestartTarget): void {
  const match = Object.entries(workflowSteps[kind]).find(([, template]) => templatePattern(template).test(target.name));
  const expectedType = match?.[0] === "wait" || match?.[0] === "retry" ? "sleep" : "do";
  if (
    !match ||
    target.type !== expectedType ||
    !Number.isSafeInteger(target.count) ||
    target.count < 1 ||
    target.name.length > 256
  ) {
    throw new Error("Invalid Workflow restart target.");
  }
}

/** Barrier/status polling is observability, not evidence of productive collection. */
export function advancesCollectionProgress(kind: WorkflowKind, name: string): boolean {
  return (
    (kind === "child" && templatePattern(workflowSteps.child.collect).test(name)) ||
    (kind === "parent" && name === workflowSteps.parent.reconcile)
  );
}
