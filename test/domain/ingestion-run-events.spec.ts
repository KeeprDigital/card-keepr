import { describe, expect, test } from "vitest";
import { emptyRunCurrent, projectIngestionRunEvent } from "../../src/catalogue/shared/ingestion-run-events";

describe("immutable Ingestion Run event projection", () => {
  const birth = {
    ingestion_run_id: "run",
    sequence_number: 1,
    event_id: "birth",
    event_kind: "created",
    occurred_at: "2026-09-04T00:00:00.000Z",
    from_state: null,
    to_state: "collecting",
    payload_json: JSON.stringify({
      payloads: {},
      current: emptyRunCurrent("run", "birth", "collecting"),
      selected_games: ["one-piece"],
    }),
  };
  test("reconstructs accepted snapshots deterministically and rejects a discontinuity", () => {
    const current = projectIngestionRunEvent(null, birth);
    expect(current.state).toBe("collecting");
    const paused = {
      ...birth,
      sequence_number: 2,
      event_id: "pause",
      event_kind: "collection_paused",
      from_state: "collecting",
      to_state: "paused",
      payload_json: JSON.stringify({
        payloads: {},
        current: {
          ...current,
          previous_state: "collecting",
          state: "paused",
          last_event_sequence: 2,
          last_event_id: "pause",
        },
      }),
    };
    expect(projectIngestionRunEvent(current, paused).state).toBe("paused");
    expect(() => projectIngestionRunEvent(null, paused)).toThrow();
    expect(() => projectIngestionRunEvent(current, { ...paused, sequence_number: 3 })).toThrow();
    expect(() => projectIngestionRunEvent(current, { ...paused, to_state: "published" })).toThrow();
  });
  test("does not invent history for a terminal snapshot", () => {
    expect(() => projectIngestionRunEvent(null, { ...birth, to_state: "published" })).toThrow();
  });
});
