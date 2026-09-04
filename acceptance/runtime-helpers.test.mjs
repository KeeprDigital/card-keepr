import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  allocatePort,
  isAddressInUse,
  portPartition,
  runProcess,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";

// The acceptance runtime's own guarantees: each file draws Worker ports from
// its private partition and skips ports another program holds, boot-collision
// detection matches the address-in-use error however the toolchain phrases
// it, and a subprocess that hangs is killed under a deadline instead of
// stalling the file until the CI job cap.

test("ports come from this process's partition, never repeat, and skip held ports", async () => {
  const { start, end } = portPartition();
  assert.ok(start >= 20_000 && end < 32_768, `${start}-${end}`);
  const holder = createServer();
  holder.unref();
  await new Promise((resolveListen) => holder.listen(start, "127.0.0.1", resolveListen));
  try {
    const ports = [];
    for (let index = 0; index < 4; index += 1) {
      ports.push(await allocatePort());
    }
    assert.equal(new Set(ports).size, ports.length, "ports never repeat");
    assert.ok(
      ports.every((port) => port > start && port <= end),
      `${ports} within ${start}-${end} and past the held port`,
    );
  } finally {
    await new Promise((resolveClose) => holder.close(resolveClose));
  }
});

test("boot-collision detection matches address-in-use errors by code and phrasing", () => {
  for (const output of [
    "Error: listen EADDRINUSE: address already in use 127.0.0.1:20000",
    "✘ [ERROR] Address already in use (127.0.0.1:20000)",
    "workerd/server/server.c++: error: Address is already in use",
    "Port 20000 is in use, please specify a different port",
  ]) {
    assert.equal(isAddressInUse(output), true, output);
  }
  for (const output of ["", '✘ [ERROR] Could not resolve "missing-module"', "Ready on http://127.0.0.1:20000"]) {
    assert.equal(isAddressInUse(output), false, output);
  }
});

test("a hanging subprocess is killed at the deadline with its output", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ["-e", "console.log('waiting'); setInterval(() => {}, 1_000)"], process.env, {
      timeoutMs: 500,
    }),
    (error) => {
      assert.match(error.message, /did not exit within 500 ms and was killed/u);
      assert.match(error.message, /stdout:\nwaiting/u);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, "the deadline is enforced promptly");
});

test("a subprocess that exits in time reports its exit code and output", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "console.log('done'); console.error('warned'); process.exit(3)"],
    process.env,
  );
  assert.deepEqual(result, { code: 3, stdout: "done\n", stderr: "warned\n" });
});

test("a subprocess that cannot be spawned fails instead of hanging", async () => {
  await assert.rejects(
    runProcess("/nonexistent/card-keepr-command", [], process.env, {
      timeoutMs: 5_000,
    }),
    { code: "ENOENT" },
  );
});

test("a slow run leaves administration request budget for candidate inspection", async (t) => {
  let now = 0;
  const requestTimes = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    now += milliseconds;
    queueMicrotask(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, "fetch", async () => {
    const recent = requestTimes.filter((time) => time > now - 60_000);
    requestTimes.push(now);
    if (recent.length >= 30) {
      return Response.json({ code: "rate_limited" }, { status: 429 });
    }
    return Response.json({ state: now >= 20_000 ? "awaiting_approval" : "collecting" });
  });
  const run = await waitForRunState(
    "slow-run",
    "awaiting_approval",
    {
      KEEPR_INGESTION_URL: "http://acceptance.invalid",
      KEEPR_ADMINISTRATION_KEY: "test-only-key",
    },
    { getOutput: () => "" },
  );
  assert.equal(run.state, "awaiting_approval");
  const inspection = await fetch("http://acceptance.invalid/v1/ingestion-runs/slow-run/candidate");
  assert.equal(inspection.status, 200, "the next candidate inspection must not be rate limited");
  assert.ok(requestTimes.length <= 10, `${requestTimes.length} requests consumed the administration budget`);
});

test("an administration polling 429 names the limiter and poll count immediately", async (t) => {
  let now = 0;
  let polls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    now += milliseconds;
    queueMicrotask(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, "fetch", async () => {
    polls += 1;
    return polls === 1
      ? Response.json({ state: "collecting" })
      : Response.json({ code: "rate_limited" }, { status: 429 });
  });
  await assert.rejects(
    waitForRunState(
      "limited-run",
      "awaiting_approval",
      {
        KEEPR_INGESTION_URL: "http://acceptance.invalid",
        KEEPR_ADMINISTRATION_KEY: "test-only-key",
      },
      { getOutput: () => "" },
    ),
    (error) => {
      assert.match(error.message, /ADMINISTRATION_RATE_LIMIT/u);
      assert.match(error.message, /429/u);
      assert.match(error.message, /poll 2/u);
      return true;
    },
  );
  assert.equal(polls, 2, "a rejected poll is never retried as an unavailable document");
});

test("a fixture's higher administration budget observes completion without a production-length sleep", async (t) => {
  let now = 0;
  let polls = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback, milliseconds) => {
    now += milliseconds;
    queueMicrotask(callback);
    return { unref() {} };
  });
  t.mock.method(globalThis, "fetch", async () => {
    polls += 1;
    return Response.json({ state: polls > 1 ? "awaiting_approval" : "collecting" });
  });
  await waitForRunState(
    "fixture-run",
    "awaiting_approval",
    {
      KEEPR_INGESTION_URL: "http://acceptance.invalid",
      KEEPR_ADMINISTRATION_KEY: "test-only-key",
    },
    { getOutput: () => "", administrationPollIntervalMs: 250 },
  );
  assert.equal(polls, 2);
  assert.equal(now, 250);
});
