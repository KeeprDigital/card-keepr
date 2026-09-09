import { expect } from "vitest";
import { get } from "./reconciliation-helpers";

export async function waitForNativeCandidates(
  runId: string,
  count: number,
  timeoutMs = 8_000,
  expectedStates: Record<string, string> = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await get(`/v1/ingestion-runs/${runId}/game-candidates`);
    expect(page.response.status).toBe(200);
    const candidates = page.document.candidates as Record<string, unknown>[];
    if (candidates.length === count) {
      const headers = await Promise.all(
        candidates.map(async ({ id }) => {
          const header = await get(`/v1/game-candidates/${id}`);
          expect(header.response.status).toBe(200);
          return header.document;
        }),
      );
      if (headers.every(({ state }) => state !== "preparing")) {
        for (const header of headers)
          expect(header).toMatchObject({
            state: expectedStates[String(header.supported_game)] ?? "sealed",
            ingestion_run_id: runId,
          });
        return headers;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`collection ${runId} did not seal ${count} native candidates`);
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
