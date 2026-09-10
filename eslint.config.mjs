import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import json from "@eslint/json";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import regexp from "eslint-plugin-regexp";
import importX from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import vitest from "@vitest/eslint-plugin";
import n from "eslint-plugin-n";

const code = ["{src,apps,test,cli,scripts,acceptance}/**/*.{ts,mts,mjs}", "*.mjs", "eslint/fixtures/*.{ts,mjs}"];
const node = [
  "{cli,scripts,acceptance}/**/*.{mjs,ts}",
  "test/domain/**/*.{ts,mjs}",
  "apps/*/vitest.config.ts",
  "test/support/fake-publisher/sqlite-restore.test.ts",
  "*.mjs",
  "eslint/fixtures/*.mjs",
];
const vitestFiles = ["eslint/fixtures/*.spec.ts", "apps/*/test/**/*.spec.ts", "test/domain/**/*.{spec.ts,test.mjs}"];
const projects = [
  "./eslint/tsconfig.shared.json",
  "./eslint/tsconfig.api.json",
  "./apps/ingestion/test/tsconfig.json",
  "./eslint/tsconfig.node.json",
];
// Matching blocks merge globals; remove Worker-only names from Node files explicitly.
const nodeGlobals = {
  ...Object.fromEntries(Object.keys(globals.worker).map((name) => [name, "off"])),
  ...globals.node,
};

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "**/.wrangler/**",
      ".claude/worktrees/**",
      "eslint/fixtures/**",
      "prototype/**",
      "acceptance/fixtures/**",
      "**/worker-configuration.d.ts",
      "src/catalogue/shared/document-validators.mjs",
      "pnpm-lock.yaml",
      "coverage/**",
      "test-results/**",
      ".artifacts/**",
    ],
  },
  {
    files: code,
    extends: [js.configs.recommended, ts.configs.base, ts.configs.eslintRecommended],
    languageOptions: {
      globals: { ...globals.worker, ...globals.node },
      parserOptions: { project: [projects[0]], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { sonarjs, unicorn, regexp, "import-x": importX },
    settings: { "import-x/resolver-next": [createTypeScriptImportResolver({ project: projects })] },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/return-await": ["error", "error-handling-correctness-only"],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "sonarjs/no-ignored-return": "error",
      "unicorn/no-invalid-fetch-options": "error",
      "import-x/no-unresolved": ["error", { ignore: ["^cloudflare:"] }],
      "import-x/no-self-import": "error",
      // Correctness checks only; spelling and quantifier preferences are deliberately omitted.
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-useless-assertions": "error",
    },
  },
  {
    files: ["apps/api/**/*.ts", "test/support/api-worker.ts"],
    languageOptions: { parserOptions: { project: [projects[1]] } },
  },
  {
    files: ["apps/ingestion/src/**/*.ts"],
    languageOptions: { parserOptions: { project: ["./apps/ingestion/tsconfig.json"] } },
  },
  { files: ["apps/ingestion/test/**/*.ts"], languageOptions: { parserOptions: { project: [projects[2]] } } },
  {
    files: node,
    plugins: { n },
    languageOptions: { globals: nodeGlobals, parserOptions: { project: [projects[3]] } },
    settings: { node: { version: "26.8.2" } },
    rules: {
      "n/no-deprecated-api": "error",
      "n/no-unsupported-features/node-builtins": ["error", { ignores: ["sqlite"] }],
      "n/no-unsupported-features/es-syntax": "error",
    },
  },
  { files: ["**/*.mjs"], rules: { "no-undef": "error" } },
  {
    // Validated HTTP input and the annotated shared CLI/release transport boundary.
    files: ["src/http/bounded-json.ts", "cli/lib/http-client.mjs", "eslint/fixtures/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  {
    files: [
      "src/catalogue/shared/{release-input-shapes,spine-revision}.mjs",
      "src/http/{administration-presentation,diagnostic-display,production-target}.mjs",
      "src/runtime-capabilities.mjs",
    ],
    languageOptions: { parserOptions: { project: ["./eslint/tsconfig.implementations.json"] } },
  },
  {
    files: vitestFiles,
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      "vitest/valid-expect-in-promise": "error",
    },
  },
  {
    files: [
      "eslint/fixtures/*.test.mjs",
      "acceptance/**/*.test.mjs",
      "test/support/fake-publisher/sqlite-restore.test.ts",
    ],
    rules: {
      // The node:test runner owns registration completion, including failures.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: false, allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: "test" }] },
      ],
    },
  },
  {
    // These files are never executed; their calls deliberately violate compiler contracts.
    files: ["test/domain/**/*.types.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    files: ["**/*.json"],
    ignores: ["**/tsconfig*.json"],
    plugins: { json },
    language: "json/json",
    extends: [json.configs.recommended],
  },
  {
    files: ["**/*.jsonc", "**/tsconfig*.json"],
    plugins: { json },
    language: "json/jsonc",
    languageOptions: { allowTrailingCommas: true },
    extends: [json.configs.recommended],
  },
  // Empty keys are valid retained data; duplicate keys and syntax remain errors.
  { files: ["**/*.json", "**/*.jsonc"], rules: { "json/no-empty-keys": "off" } },
  prettier,
]);
