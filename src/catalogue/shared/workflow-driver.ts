import { assertWorkflowRestartTarget, type WorkflowKind, type WorkflowRestartTarget } from "./workflow-steps";
export type WorkflowStatus = Awaited<ReturnType<WorkflowInstance["status"]>>;

/** Only confirmed absence permits creation; transport errors must reach the caller's retry policy. */
export function isWorkflowInstanceNotFound(error: unknown): boolean {
  return error instanceof Error && /not[._ ]?found/iu.test(`${error.name} ${error.message}`);
}

/** Read-only inspection also serves readiness probes with no dispatch capability. */
export async function inspectWorkflowInstance<Status extends { status: string }>(
  binding: { get(id: string): Promise<{ status(): Promise<Status> }> },
  id: string,
): Promise<Status> {
  return (await binding.get(id)).status();
}

/** The only boundary to the Workflow control plane. Deterministic IDs fence concurrent dispatch. */
export function workflowDriver<Params>(binding: Workflow<Params>) {
  async function inspect(id: string): Promise<WorkflowStatus> {
    return inspectWorkflowInstance(binding, id);
  }
  async function ensure(
    id: string,
    params: Params,
    options: { createRequested?: boolean } = {},
  ): Promise<{ created: boolean; status: WorkflowStatus }> {
    if (!options.createRequested) {
      try {
        const status = await inspect(id);
        if (status.status !== "unknown") return { created: false, status };
      } catch (error) {
        if (!isWorkflowInstanceNotFound(error)) throw error;
      }
    }
    let instance: WorkflowInstance;
    try {
      instance = await binding.create({ id, params });
    } catch (error) {
      // A lost create response or concurrent create is resolved only by positively
      // observing that exact identity. Never turn another failure into absence.
      try {
        const status = await inspect(id);
        if (status.status !== "unknown") return { created: false, status };
      } catch {
        // Preserve the original dispatch failure when existence cannot be proved.
      }
      throw error;
    }
    return { created: true, status: await instance.status() };
  }
  async function resume(id: string): Promise<WorkflowStatus> {
    const instance = await binding.get(id);
    const before = await instance.status();
    if (before.status !== "paused") return before;
    try {
      await instance.resume();
    } catch (error) {
      const after = await instance.status();
      if (!["running", "queued", "waiting", "complete"].includes(after.status)) throw error;
      return after;
    }
    return instance.status();
  }
  async function terminate(id: string): Promise<void> {
    await (await binding.get(id)).terminate();
  }
  async function ensureBatch(batch: readonly { id: string; params: Params }[]): Promise<void> {
    await binding.createBatch([...batch]);
    for (const { id } of batch) await resume(id);
  }
  async function restart(id: string, kind: WorkflowKind, from: WorkflowRestartTarget): Promise<void> {
    assertWorkflowRestartTarget(kind, from);
    await (await binding.get(id)).restart({ from });
  }
  return { ensure, inspect, resume, terminate, ensureBatch, restart };
}
