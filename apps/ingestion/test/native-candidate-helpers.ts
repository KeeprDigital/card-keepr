import { expect } from "vitest";
import { get, requiredString, testEnv } from "./reconciliation-helpers";

/** Observe the operation returned by creation, never whichever candidate happens to share its collection. */
export async function waitForNativeCandidate(id: string, expectedState = "sealed", timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let observed: Record<string, unknown> = {};
  do {
    const header = await get(`/v1/game-candidates/${id}`);
    expect(header.response.status, JSON.stringify(header.document)).toBe(200);
    observed = header.document;
    if (observed.state !== "preparing") {
      expect(observed, JSON.stringify(observed)).toMatchObject({ id, state: expectedState });
      return observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Native candidate ${id} remained preparing: ${JSON.stringify(observed)}`);
}

/** A wiring test must observe an actual parent dispatch receipt. This helper never creates missing candidates. */
export async function waitForDispatchedNativeCandidates(
  runId: string,
  count: number,
  timeoutMs = 8_000,
  expectedStates: Record<string, string> = {},
) {
  const deadline = Date.now() + timeoutMs;
  const collection = await get(`/v1/ingestion-runs/${runId}`);
  const workflow = collection.document.workflow as { parent_id?: string } | undefined;
  if (!workflow?.parent_id)
    throw new Error(`Collection ${runId} has no Workflow parent; request native preparation explicitly.`);
  const parent = await testEnv.EVIDENCE_INGESTION_WORKFLOW.get(workflow.parent_id);
  do {
    const status = await parent.status();
    if (status.status === "complete") {
      const output = status.output as
        | { ingestion_run_id?: string; game_preparations?: Record<string, unknown>[] }
        | undefined;
      if (!Array.isArray(output?.game_preparations))
        throw new Error(
          `Collection ${runId} completed without native dispatch; request native preparation explicitly.`,
        );
      expect(output.ingestion_run_id).toBe(runId);
      expect(output.game_preparations).toHaveLength(count);
      const candidates = await Promise.all(
        output.game_preparations.map(async (receipt) => {
          const candidate = await waitForNativeCandidate(
            requiredString(receipt, "id"),
            expectedStates[String(receipt.supported_game)] ?? "sealed",
            Math.max(1, deadline - Date.now()),
          );
          expect(candidate).toMatchObject({ ingestion_run_id: runId, supported_game: receipt.supported_game });
          return candidate;
        }),
      );
      expect(new Set(candidates.map(({ id }) => id)).size).toBe(count);
      return candidates;
    }
    if (["errored", "terminated"].includes(status.status))
      throw new Error(`Collection parent ${workflow.parent_id} ${status.status}: ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error(`Collection ${runId} has not returned its native dispatch receipt.`);
}

export async function nativeCandidateRecords(candidateId: string) {
  const records: Record<string, Record<string, unknown>[]> = {};
  let cursor: string | null = null;
  do {
    const page = await get(
      `/v1/game-candidates/${candidateId}/partitions${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(page.response.status).toBe(200);
    for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
      const detail = await get(`/v1/game-candidates/${candidateId}/partitions/${partition.ordinal}`);
      expect(detail.response.status).toBe(200);
      records[partition.kind] ??= [];
      records[partition.kind]!.push(...(detail.document.records as Record<string, unknown>[]));
    }
    const nextCursor = page.document.next_cursor as string | null;
    if (nextCursor !== null) expect(nextCursor).not.toBe(cursor);
    cursor = nextCursor;
  } while (cursor !== null);
  return records;
}
