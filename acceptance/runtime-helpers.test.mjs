import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  allocatePort,
  isAddressInUse,
  portPartition,
  runProcess,
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
  await new Promise((resolveListen) =>
    holder.listen(start, "127.0.0.1", resolveListen)
  );
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
  for (const output of [
    "",
    "✘ [ERROR] Could not resolve \"missing-module\"",
    "Ready on http://127.0.0.1:20000",
  ]) {
    assert.equal(isAddressInUse(output), false, output);
  }
});

test("a hanging subprocess is killed at the deadline with its output", async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(
      process.execPath,
      ["-e", "console.log('waiting'); setInterval(() => {}, 1_000)"],
      process.env,
      { timeoutMs: 500 },
    ),
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
