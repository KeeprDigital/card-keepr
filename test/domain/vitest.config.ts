import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Runtime-free catalogue tests (issue #92): parsers, reconciliation identity,
// export, and contract checks that import src/catalogue directly
// and need neither the Workers pool nor a wrangler boot. Anything that
// touches D1, R2, Workflows, or the worker entrypoints belongs in
// apps/*/test (workers pool) or acceptance/ (real wrangler).
export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  test: {
    include: ["test/domain/**/*.spec.ts", "test/domain/**/*.test.mjs"],
    environment: "node",
    testTimeout: 30_000,
  },
});
