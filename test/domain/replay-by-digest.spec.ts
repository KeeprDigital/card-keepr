import { expect, test } from "vitest";
import { AdministrationProblem, replayByDigest } from "../../src/catalogue/shared";

type Retained = { request_digest: string; response_json: string };

const retained: Retained = {
  request_digest: "digest-a",
  response_json: '{"ok":true}',
};

test("a key nobody has used yet retains nothing to replay", async () => {
  const replay = await replayByDigest<Retained>({
    lookup: async () => null,
    retainedDigest: (row) => row.request_digest,
    requestDigest: "digest-a",
    conflictDetail: "The idempotency key is already bound to another request.",
  });
  expect(replay).toBeNull();
});

test("a matching digest replays the retained row", async () => {
  const replay = await replayByDigest<Retained>({
    lookup: async () => retained,
    retainedDigest: (row) => row.request_digest,
    requestDigest: "digest-a",
    conflictDetail: "The idempotency key is already bound to another request.",
  });
  expect(replay).toBe(retained);
});

test("a different digest under the same key is a 409 idempotency_conflict", async () => {
  const attempt = replayByDigest<Retained>({
    lookup: async () => retained,
    retainedDigest: (row) => row.request_digest,
    requestDigest: "digest-b",
    conflictDetail: "The idempotency key was already used for a different termination.",
  });
  await expect(attempt).rejects.toBeInstanceOf(AdministrationProblem);
  await expect(attempt).rejects.toMatchObject({
    status: 409,
    code: "idempotency_conflict",
    message: "The idempotency key was already used for a different termination.",
    persistOutcome: true,
  });
});
