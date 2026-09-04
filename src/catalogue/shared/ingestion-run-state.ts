/** Persisted Ingestion Run states. The const object also works in Node's type-stripping schema scripts. */
export const IngestionRunState = {
  Planning: "planning",
  Collecting: "collecting",
  Paused: "paused",
  Parsing: "parsing",
  Reconciling: "reconciling",
  AwaitingApproval: "awaiting_approval",
  Publishing: "publishing",
  Published: "published",
  Rejected: "rejected",
  Expired: "expired",
  Failed: "failed",
} as const;
export type IngestionRunState = (typeof IngestionRunState)[keyof typeof IngestionRunState];

export const ingestionRunTerminatedFailureCode = "ingestion_run_terminated";

type Transition = Readonly<{ to: IngestionRunState; requires?: "termination" }>;

/** State changes only: idempotent SQL updates that keep the same state are not transitions. */
export const ingestionRunTransitions: Readonly<Record<IngestionRunState, readonly Transition[]>> = {
  planning: [{ to: "collecting" }, { to: "failed" }],
  collecting: [{ to: "paused" }, { to: "parsing" }, { to: "failed" }],
  paused: [{ to: "collecting" }, { to: "failed", requires: "termination" }],
  parsing: [{ to: "reconciling" }, { to: "failed" }],
  reconciling: [{ to: "awaiting_approval" }, { to: "failed" }],
  awaiting_approval: [{ to: "publishing" }, { to: "rejected" }, { to: "expired" }, { to: "failed" }],
  publishing: [{ to: "published" }, { to: "failed" }],
  published: [],
  rejected: [],
  expired: [],
  failed: [],
};

export const ingestionRunStates: readonly IngestionRunState[] = Object.values(IngestionRunState);

/** Paused is non-terminal but never a completed progress stage. */
export const activeRunStages = [
  IngestionRunState.Planning,
  IngestionRunState.Collecting,
  IngestionRunState.Parsing,
  IngestionRunState.Reconciling,
  IngestionRunState.AwaitingApproval,
  IngestionRunState.Publishing,
] as const;

export function isIngestionRunState(value: unknown): value is IngestionRunState {
  return typeof value === "string" && Object.hasOwn(ingestionRunTransitions, value);
}

export function isTerminalIngestionRunState(state: string): boolean {
  return isIngestionRunState(state) && ingestionRunTransitions[state].length === 0;
}

export type IngestionRunTransitionFacts = Readonly<{
  failureCode?: string | null;
  terminationRecorded?: boolean;
}>;

export function canTransitionIngestionRun(
  from: string,
  to: IngestionRunState,
  facts: IngestionRunTransitionFacts = {},
): boolean {
  if (!isIngestionRunState(from)) return false;
  const transition = ingestionRunTransitions[from].find((candidate) => candidate.to === to);
  return (
    transition !== undefined &&
    (transition.requires !== "termination" ||
      (facts.failureCode === ingestionRunTerminatedFailureCode && facts.terminationRecorded === true))
  );
}

/** Domain callers may keep their action-specific problem; SQL still compare-and-sets the source state. */
export function assertIngestionRunTransition(
  from: string,
  to: IngestionRunState,
  options: IngestionRunTransitionFacts & { requiredFrom?: IngestionRunState; invalid?: () => Error } = {},
): void {
  if (
    (options.requiredFrom !== undefined && from !== options.requiredFrom) ||
    !canTransitionIngestionRun(from, to, options)
  ) {
    throw options.invalid?.() ?? new Error(`Illegal Ingestion Run transition: ${from} -> ${to}.`);
  }
}

/** Eligible source states for a transition, excluding termination unless its facts are supplied. */
export function ingestionRunTransitionSources(
  to: IngestionRunState,
  facts: IngestionRunTransitionFacts = {},
): readonly IngestionRunState[] {
  return ingestionRunStates.filter((from) => canTransitionIngestionRun(from, to, facts));
}

/**
 * Validate the planned edge and retain a compare-and-set on its source in SQL.
 * Workflow replays may observe a later state: then the UPDATE stays a no-op.
 * The trigger verifies the same table against the actual row under concurrency.
 */
export function ingestionRunTransitionSql(
  from: IngestionRunState | readonly IngestionRunState[],
  to: IngestionRunState,
  facts: IngestionRunTransitionFacts = {},
): string {
  const sources = typeof from === "string" ? [from] : from;
  if (sources.length === 0) throw new Error("An Ingestion Run transition requires a source state.");
  for (const source of sources) assertIngestionRunTransition(source, to, facts);
  return sources.length === 1
    ? `state = '${sources[0]}'`
    : `state IN (${sources.map((source) => `'${source}'`).join(", ")})`;
}
