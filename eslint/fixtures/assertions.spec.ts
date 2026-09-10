import { expect, test } from "vitest";
test.only("focused", () => { expect(1).toBe(1); }); // probe:focus
// Static diagnostics only: no probe in this directory is executed.
test("unawaited", () => {
  expect(Promise.resolve(1)).resolves.toBe(1); // probe:unawaited-expect
});
test("invalid matcher", () => {
  expect(1); // probe:invalid-expect
});
test("invalid resolves input", async () => {
  await expect(1).resolves.toBe(1); // probe:nonpromise-resolves
});
test("awaited", async () => { await expect(Promise.resolve(1)).resolves.toBe(1); });
test("returned", () => expect(Promise.resolve(1)).resolves.toBe(1));
test("combined", async () => {
  await Promise.all([expect(Promise.resolve(1)).resolves.toBe(1), expect(Promise.resolve(2)).resolves.toBe(2)]);
});
test("message", () => { expect(1, "diagnostic context").toBe(1); });
