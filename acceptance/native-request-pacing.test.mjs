import assert from "node:assert/strict";
import test from "node:test";
import { createNativeRequestQueue } from "./helpers/native-request-pacing.mjs";

function clock() {
  let now = 0;
  const waits = [];
  return {
    now: () => now,
    sleep: (ms) => new Promise((resolve) => waits.push({ at: now + ms, resolve })),
    async flush() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    async next(lag = 0) {
      await this.flush();
      waits.sort((a, b) => a.at - b.at);
      const next = waits.shift();
      assert.ok(next, "a paced request must wait");
      now = next.at + lag;
      next.resolve();
      await this.flush();
    },
  };
}
const environment = { KEEPR_INGESTION_URL: "http://localhost:8788", KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200" };

test("interleaved CLI, helper and poll traffic share per-origin headroom", async () => {
  const time = clock();
  const request = createNativeRequestQueue(time);
  const starts = [];
  const jobs = Array.from({ length: 31 }, (_, i) =>
    request(
      { ...environment, KEEPR_INGESTION_URL: `${environment.KEEPR_INGESTION_URL}/${["cli", "helper", "poll"][i % 3]}` },
      () => starts.push(time.now()),
    ),
  );
  let independent;
  await request({ ...environment, KEEPR_INGESTION_URL: "http://localhost:8789" }, () => {
    independent = time.now();
  });
  assert.equal(independent, 0);
  for (let i = 1; i < jobs.length; i++) await time.next();
  await Promise.all(jobs);
  assert.deepEqual(
    starts,
    Array.from({ length: 31 }, (_, i) => i * 2200),
  );
  for (const start of starts) assert.ok(starts.filter((at) => at >= start && at < start + 60000).length <= 28);
});

test("slow responses and failed actions cannot produce catch-up bursts or retries", async () => {
  const time = clock();
  const request = createNativeRequestQueue(time);
  const starts = [];
  const failure = new Error("rate_limited");
  let attempts = 0;
  const failed = request(environment, async () => {
    starts.push(time.now());
    attempts++;
    await time.sleep(5000);
    throw failure;
  });
  const observed = assert.rejects(failed, (error) => error === failure);
  const next = request(environment, () => starts.push(time.now()));
  const last = request(environment, () => starts.push(time.now()));
  await time.next(3000); // Slow action completes at 8000, not its planned 5000.
  await time.next();
  await time.next();
  await Promise.all([observed, next, last]);
  assert.equal(attempts, 1);
  assert.deepEqual(starts, [0, 10200, 12400]);
});

test("fixtures without an interval keep their existing unpaced behavior", async () => {
  const request = createNativeRequestQueue({
    sleep: () => {
      throw Error("unexpected delay");
    },
  });
  assert.equal(await request({}, () => 42), 42);
  for (const interval of ["bad", "-1"])
    assert.throws(() => request({ ...environment, KEEPR_NATIVE_REQUEST_INTERVAL_MS: interval }, () => {}), RangeError);
});

test("shipped CLI, native reads and administration polls use the same queue", async (t) => {
  const { createServer } = await import("node:http");
  const { runCli, administrationDocument } = await import("./helpers/acceptance-runtime.mjs");
  const { waitForNativeCollection } = await import("./helpers/native-catalogue-runtime.mjs");
  const arrivals = [];
  const server = createServer((request, response) => {
    arrivals.push({ path: request.url, at: performance.now() });
    response.writeHead(200, { "content-type": "application/json" });
    const document = {
      state: "parsing",
      evidence_plans: [{ supported_game: "one-piece" }],
      candidates: [{ id: "candidate", state: "sealed" }],
    };
    response.end(
      JSON.stringify(
        request.headers.accept === "application/vnd.card-keepr.cli+json"
          ? { contract: "card-keepr-cli-presentation@1", text: "candidate", exit_code: 0, document }
          : document,
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = {
    KEEPR_INGESTION_URL: `http://127.0.0.1:${server.address().port}`,
    KEEPR_ADMINISTRATION_KEY: "synthetic-queue-key",
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "50",
  };
  const [cli] = await Promise.all([
    runCli(["game-candidate", "show", "--candidate-id", "candidate", "--json"], env),
    administrationDocument("/v1/direct-poll", env),
    waitForNativeCollection("run", "sealed", env, { getOutput: () => "" }),
  ]);
  assert.equal(cli.code, 0, cli.stdout + cli.stderr);
  assert.equal(arrivals.length, 5);
  for (let i = 1; i < arrivals.length; i++)
    assert.ok(arrivals[i].at - arrivals[i - 1].at >= 45, JSON.stringify(arrivals));
});
