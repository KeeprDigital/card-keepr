import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recaptureOfficialBytes } from "../scripts/recapture-official-bytes.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, body = Buffer.from("before retained after")) {
  const directory = await mkdtemp(join(tmpdir(), "keepr-recapture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const capture = {
    source_url: "https://example.invalid/cards",
    retrieved_at: "2026-09-01T00:00:00Z",
    http_status: 200,
    content_type: "text/html",
    effective_url: "https://example.invalid/cards",
    full_body_sha256: digest(body),
    full_body_size: body.length,
    range_start: 7,
    range_end_exclusive: 15,
    body_sha256: digest(body.subarray(7, 15)),
    body_base64: body.subarray(7, 15).toString("base64"),
  };
  await writeFile(join(directory, "capture.json"), JSON.stringify(capture));
  return { directory, output: join(directory, "recaptured"), body, capture };
}

test("recapture verifies retained ranges and full live bytes without changing golden files", async (t) => {
  const input = await fixture(t);
  const original = await readFile(join(input.directory, "capture.json"), "utf8");
  const result = await recaptureOfficialBytes({
    fixturesDirectory: input.directory,
    outputDirectory: input.output,
    fetch: async () => new Response(input.body, { headers: { "content-type": "text/html" } }),
    intervalMs: 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.captures.length, 1);
  assert.equal(result.captures[0].status, "unchanged");
  assert.equal(await readFile(join(input.directory, "capture.json"), "utf8"), original);
});

test("live full-body drift fails even when the retained byte range remains identical", async (t) => {
  const input = await fixture(t);
  const result = await recaptureOfficialBytes({
    fixturesDirectory: input.directory,
    outputDirectory: input.output,
    fetch: async () => new Response(Buffer.from("BEFORE retained after")),
    intervalMs: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.captures[0].status, "drift");
  assert.deepEqual(result.captures[0].differences, ["full_body_sha256"]);
});

test("invalid retained digests fail before fetching and transport errors remain actionable", async (t) => {
  const input = await fixture(t);
  await writeFile(
    join(input.directory, "capture.json"),
    JSON.stringify({ ...input.capture, body_sha256: "0".repeat(64) }),
  );
  let fetched = false;
  const invalid = await recaptureOfficialBytes({
    fixturesDirectory: input.directory,
    outputDirectory: input.output,
    fetch: async () => {
      fetched = true;
      throw new Error("offline");
    },
    intervalMs: 0,
  });
  assert.equal(fetched, false);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.captures[0].status, "invalid_golden");
  await writeFile(join(input.directory, "capture.json"), JSON.stringify(input.capture));
  const failed = await recaptureOfficialBytes({
    fixturesDirectory: input.directory,
    outputDirectory: join(input.directory, "failed"),
    fetch: async () => {
      throw new Error("offline");
    },
    intervalMs: 0,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.captures[0].status, "fetch_failed");
  assert.match(failed.captures[0].error, /offline/u);
});

for (const alias of ["direct", "symlink"]) {
  test(`recapture rejects a ${alias} output alias of the golden directory before fetching or writing`, async (t) => {
    const input = await fixture(t);
    const original = await readFile(join(input.directory, "capture.json"), "utf8");
    const output = alias === "direct" ? input.directory : input.output;
    if (alias === "symlink") await symlink(input.directory, output, "dir");
    let fetched = false;
    await assert.rejects(
      recaptureOfficialBytes({
        fixturesDirectory: input.directory,
        outputDirectory: output,
        intervalMs: 0,
        fetch: async () => {
          fetched = true;
          return new Response(input.body);
        },
      }),
      /output directory.*golden directory/iu,
    );
    assert.equal(fetched, false);
    assert.equal(await readFile(join(input.directory, "capture.json"), "utf8"), original);
  });
}

for (const filename of ["capture.json", "report.json"]) {
  test(`recapture never follows an existing ${filename} output symlink into a golden file`, async (t) => {
    const input = await fixture(t);
    const golden = join(input.directory, "capture.json");
    const original = await readFile(golden, "utf8");
    await mkdir(input.output);
    await symlink(golden, join(input.output, filename));
    const recapture = recaptureOfficialBytes({
      fixturesDirectory: input.directory,
      outputDirectory: input.output,
      intervalMs: 0,
      fetch: async () => new Response(input.body),
    });
    if (filename === "report.json") await assert.rejects(recapture, { code: "EEXIST" });
    else {
      const result = await recapture;
      assert.equal(result.ok, false);
      assert.match(result.captures[0].error, /EEXIST/u);
    }
    assert.equal(await readFile(golden, "utf8"), original);
  });
}
