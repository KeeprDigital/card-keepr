import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";

installRuntimeSuite();

type LogEntry = {
  contract: string;
  sequence: number;
  credential_class: string;
  operator_note: string;
  recorded_at: string;
  idempotency_key: string;
};

async function appendEntry(
  body: Record<string, unknown>,
  bearer = "vitest-administration-key",
): Promise<{ status: number; document: Record<string, unknown> }> {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/credential-rotation-log", {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "cf-connecting-ip": "192.0.2.87",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-09-02T10:00:00.000Z",
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    document: await response.json<Record<string, unknown>>(),
  };
}

async function listEntries(): Promise<{
  status: number;
  document: { contract: string; entries: LogEntry[] };
}> {
  const response = await administrationRequest(
    "/v1/credential-rotation-log",
    "GET",
  );
  return {
    status: response.status,
    document: await response.json<{ contract: string; entries: LogEntry[] }>(),
  };
}

// The log is append-only and this suite shares one database, so every
// assertion is scoped to the keys the test itself appended.
function entriesUnderKeys(
  entries: readonly LogEntry[],
  keys: readonly string[],
): LogEntry[] {
  return entries.filter((entry) => keys.includes(entry.idempotency_key));
}

test("a rotation is recorded as an immutable log entry readable through the log route", async () => {
  const appended = await appendEntry({
    credential_class: "ingestion_admin_key",
    operator_note: "Promoted replacement after health verification.",
    idempotency_key: "rotation_ingestion_admin_2026-09-02",
  });
  expect(appended.status).toBe(201);
  expect(appended.document).toEqual({
    contract: "card-keepr-credential-rotation-log-entry@1",
    sequence: expect.any(Number),
    credential_class: "ingestion_admin_key",
    operator_note: "Promoted replacement after health verification.",
    recorded_at: "2026-09-02T10:00:00.000Z",
    idempotency_key: "rotation_ingestion_admin_2026-09-02",
  });

  const listed = await listEntries();
  expect(listed.status).toBe(200);
  expect(listed.document.contract).toBe(
    "card-keepr-credential-rotation-log@1",
  );
  expect(entriesUnderKeys(listed.document.entries, [
    "rotation_ingestion_admin_2026-09-02",
  ])).toEqual([appended.document]);

  await expect(
    env.CATALOGUE_DB.prepare(
      "UPDATE credential_rotation_log SET operator_note = 'edited'",
    ).run(),
  ).rejects.toThrowError(/credential_rotation_log_immutable/u);
  await expect(
    env.CATALOGUE_DB.prepare("DELETE FROM credential_rotation_log").run(),
  ).rejects.toThrowError(/credential_rotation_log_immutable/u);
});

test("replaying an idempotency key returns the original entry and a changed request conflicts", async () => {
  const body = {
    credential_class: "api_bearer_key",
    operator_note: "Rotated the API bearer key.",
    idempotency_key: "rotation_api_bearer_2026-09-02",
  };
  const first = await appendEntry(body);
  expect(first.status).toBe(201);
  const replayed = await appendEntry(body);
  expect(replayed.status).toBe(200);
  expect(replayed.document).toEqual(first.document);

  const conflicting = await appendEntry({
    ...body,
    operator_note: "A different note under the same key.",
  });
  expect(conflicting.status).toBe(409);
  expect(conflicting.document).toMatchObject({ code: "idempotency_conflict" });

  const listed = await listEntries();
  expect(entriesUnderKeys(listed.document.entries, [body.idempotency_key]))
    .toEqual([first.document]);
});

test("entries list in append order across credential classes", async () => {
  await appendEntry({
    credential_class: "api_bearer_key",
    operator_note: "first",
    idempotency_key: "rotation_order_1",
  });
  await appendEntry({
    credential_class: "ingestion_admin_key",
    operator_note: "second",
    idempotency_key: "rotation_order_2",
  });
  const listed = await listEntries();
  const ordered = entriesUnderKeys(listed.document.entries, [
    "rotation_order_1",
    "rotation_order_2",
  ]);
  expect(ordered.map((entry) => [entry.credential_class, entry.operator_note]))
    .toEqual([["api_bearer_key", "first"], ["ingestion_admin_key", "second"]]);
  expect(ordered[1]!.sequence).toBeGreaterThan(ordered[0]!.sequence);
  const sequences = listed.document.entries.map((entry) => entry.sequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
});

test("an unknown credential class, a missing note, or a stray field is refused", async () => {
  const unknownClass = await appendEntry({
    credential_class: "cloudflare_api_token",
    operator_note: "not a worker bearer key",
    idempotency_key: "rotation_invalid_1",
  });
  expect(unknownClass.status).toBe(422);
  expect(unknownClass.document).toMatchObject({
    code: "credential_class_invalid",
  });
  const missingNote = await appendEntry({
    credential_class: "api_bearer_key",
    idempotency_key: "rotation_invalid_2",
  });
  expect(missingNote.status).toBe(422);
  const strayField = await appendEntry({
    credential_class: "api_bearer_key",
    operator_note: "note",
    idempotency_key: "rotation_invalid_3",
    secret: "never-accepted",
  });
  expect(strayField.status).toBe(422);
  expect(entriesUnderKeys((await listEntries()).document.entries, [
    "rotation_invalid_1",
    "rotation_invalid_2",
    "rotation_invalid_3",
  ])).toEqual([]);
});

test("the replacement administration key can record a rotation during the overlap", async () => {
  const appended = await appendEntry(
    {
      credential_class: "ingestion_admin_key",
      operator_note: "Recorded with the replacement key before clearing the old value.",
      idempotency_key: "rotation_replacement_slot_1",
    },
    "vitest-administration-key-replacement-slot",
  );
  expect(appended.status).toBe(201);
});
