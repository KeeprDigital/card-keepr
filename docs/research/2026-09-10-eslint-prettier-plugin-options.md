# ESLint and Prettier plugin options for Card Keepr

> Historical assessment, superseded by the completed pnpm/Corepack and
> ESLint/Prettier migrations. Use [Toolchain](../toolchain.md) and
> [Commands](../commands.md) for current setup and supported commands.
> The findings below retain the original investigation context.

Researched 2026-09-10 against official documentation and live npm registry
metadata. This is an advisory design; no dependencies or configuration were
changed. See the broader [toolchain comparison](2026-09-10-lint-toolchain-comparison.md)
for the existing Biome baseline.

## Compatibility comes first

The repository declares TypeScript `^7.0.2`. The currently published
`typescript-eslint` **8.70.0** declares TypeScript `>=4.8.4 <6.1.0`, consistent
with its official support documentation. Directly using TS7 as ESLint's compiler
API is unsupported; neither ignoring the peer dependency nor suppressing the
parser warning proves compatibility.
[Package manifest](https://registry.npmjs.org/typescript-eslint/8.70.0),
[supported versions](https://typescript-eslint.io/users/dependency-versions/).

Correction after further investigation: Microsoft explicitly documents keeping
TS7 for compilation while providing the TS6 API to tools such as typescript-eslint
through package aliases. A compiler downgrade is therefore optional. The
documented roles are `typescript` aliased to `@typescript/typescript6` and
`@typescript/native` aliased to TS7; their commands are `tsc6` and `tsc`.
This is the preferred coexistence path to trial, preserving fast checks and
enabling typed lint. Verify pnpm resolution and real lint diagnostics before
adoption; this combination has not been installed here.
[Microsoft's coexistence guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0).

### Bounded compiler compatibility check

All five existing compiler projects passed unchanged under both TS6.0.3 and
TS7.0.2. TS6 was downloaded from the npm registry into a disposable directory;
the repository's compiler dependency was not replaced. Each command used
`--project`, `--pretty false`, and `--noEmit` with the existing compiler options.

| Project          | TS6.0.3 seconds | TS7.0.2 seconds | Result    |
| ---------------- | --------------- | --------------- | --------- |
| API source       | 2.07            | 0.30            | Both pass |
| API tests        | 1.75            | 0.24            | Both pass |
| Ingestion source | 1.71            | 0.26            | Both pass |
| Ingestion tests  | 3.03            | 0.41            | Both pass |
| Domain tests     | 2.04            | 0.26            | Both pass |
| Total            | 10.60           | 1.47            | Both pass |

These are single sequential local samples, TS6 first and TS7 second, on the
available Node v26.3.0 shell rather than the repository-pinned v26.8.2. They are
useful diagnostic evidence, not a controlled benchmark, CI timing prediction,
or full migration validation. No runtime tests, bundle comparisons, or ESLint
integration were exercised. The result supports TS6 source compatibility for
the current five projects; it does not establish universal TS6/TS7 equivalence.

The relevant package versions verified from the registry are:

| Package                                                                                                   | Published version | Relevant requirement                    |
| --------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------- |
| [`eslint`](https://registry.npmjs.org/eslint/10.10.0)                                                     | 10.10.0           | Node `^20.19.0 \|\| ^22.13.0 \|\| >=24` |
| [`typescript-eslint`](https://registry.npmjs.org/typescript-eslint/8.70.0)                                | 8.70.0            | ESLint 8.57/9/10; TypeScript `<6.1.0`   |
| [`eslint-plugin-import-x`](https://registry.npmjs.org/eslint-plugin-import-x/4.17.1)                      | 4.17.1            | ESLint 8.57/9/10                        |
| [`eslint-import-resolver-typescript`](https://registry.npmjs.org/eslint-import-resolver-typescript/4.4.5) | 4.4.5             | Supports import-x                       |
| [`@vitest/eslint-plugin`](https://registry.npmjs.org/@vitest/eslint-plugin/1.6.27)                        | 1.6.27            | ESLint `>=8.57`; Vitest peer `*`        |
| [`eslint-plugin-unicorn`](https://registry.npmjs.org/eslint-plugin-unicorn/74.0.0)                        | 74.0.0            | ESLint `>=10.4`; Node `>=22`            |
| [`eslint-plugin-regexp`](https://registry.npmjs.org/eslint-plugin-regexp/3.3.0)                           | 3.3.0             | ESLint `>=9.38`                         |
| [`@eslint/json`](https://registry.npmjs.org/@eslint/json/2.1.0)                                           | 2.1.0             | Modern ESLint language plugin           |
| [`eslint-config-prettier`](https://registry.npmjs.org/eslint-config-prettier/10.1.8)                      | 10.1.8            | ESLint `>=7`                            |
| [`prettier`](https://registry.npmjs.org/prettier/3.9.6)                                                   | 3.9.6             | Node `>=14`                             |

The repository's Node `>=26.8.2` satisfies these declared engines. A future
migration should choose and pin a verified compatible set, rather than copy
these versions indefinitely. In particular, latest Unicorn is not an ESLint 9
recommendation. Registry peer ranges establish declared compatibility, not a
successful run on this repository.

## Recommended ownership and presets

Use an ESM flat config (`eslint.config.mjs`) with separate file-scoped sections
for Worker TypeScript, Node scripts, Vitest tests, Node acceptance tests, and
JSON/JSONC. Start with `@eslint/js` recommended rules and `globals`; then add
the following focused layers.

| Layer                                 | Recommendation and purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `typescript-eslint`                   | Following the owner's clarification that broad bug detection matters more than exact Biome parity, target `strictTypeChecked` with reviewed exceptions and explicit additional checks such as exhaustiveness. It already includes recommended rules; do not stack both. `stylisticTypeChecked` is optional code-pattern consistency, not whitespace formatting. Strict presets can change outside major releases; avoid `all`. [Preset guidance](https://typescript-eslint.io/users/configs/)                                                                                                          |
| `eslint-plugin-import-x` + resolver   | Use `flatConfigs.recommended` plus `flatConfigs.typescript`, review defaults, and add `no-extraneous-dependencies` with test/config exceptions and `no-duplicates`. Use `import-x/order` only if automatic import ordering is wanted; it is an addition to the current workflow, not necessary formatting parity. [Import-x documentation](https://github.com/un-ts/eslint-plugin-import-x), [duplicate imports](https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/no-duplicates.md), [ordering](https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/order.md) |
| `@vitest/eslint-plugin`               | Apply recommended rules only to Vitest files in `apps/*/test` and `test/domain`, including relevant `.mjs` tests. Explicitly make focused tests an error. Retain valid-expect and valid-expect-in-promise checks. Do not apply the preset to `acceptance/*.test.mjs`: those use `node:test`. [Plugin documentation](https://github.com/vitest-dev/eslint-plugin-vitest)                                                                                                                                                                                                                                |
| `eslint-plugin-unicorn`               | Select useful rules instead of adopting its large recommended preset blindly. Candidates include `no-array-fill-with-reference-type`, `no-await-in-promise-methods`, `no-invalid-fetch-options`, `error-message`, `throw-new-error`, `text-encoding-identifier-case`, and `no-abusive-eslint-disable`. Avoid unrelated naming, null, loop, and array-style churn. [Rules and configuration](https://github.com/sindresorhus/eslint-plugin-unicorn)                                                                                                                                                     |
| `eslint-plugin-regexp`                | Use `configs.recommended` for regex correctness and problematic backtracking. Its `all` preset is explicitly intended for testing, not production. Review style-only findings and preserve the current control-character warning deliberately; recommended presets do not reproduce every Biome rule. [Plugin guidance](https://github.com/ota-meshi/eslint-plugin-regexp)                                                                                                                                                                                                                             |
| `eslint-plugin-n`                     | Add Node runtime/import checks only for the CLI, operational scripts, Node acceptance tests, and Node-executed configuration files. Select rules that add value beyond import-x; avoid duplicate resolution reports. Do not apply the Node runtime preset globally to deployed Worker modules. [Node plugin](https://github.com/eslint-community/eslint-plugin-n)                                                                                                                                                                                                                                      |
| `@eslint/json`                        | Prefer the official language plugin's `json/recommended` for ordinary JSON and JSONC: duplicate/empty/unnormalized keys and unsafe values. Treat `tsconfig*.json`, `.vscode/*.json`, and Wrangler configs as JSONC with `allowTrailingCommas: true` where appropriate. [Official JSON plugin](https://github.com/eslint/json)                                                                                                                                                                                                                                                                          |
| `prettier` + `eslint-config-prettier` | Run Prettier separately; put `eslint-config-prettier/flat` after conflicting rule configs. Do not install `eslint-plugin-prettier`: Prettier's maintainers describe the extra editor noise, slowdown, and indirection. [Prettier integration](https://prettier.io/docs/integrating-with-linters), [flat config integration](https://github.com/prettier/eslint-config-prettier)                                                                                                                                                                                                                        |

`eslint-plugin-jsonc` is an alternative if its additional rules are specifically
needed, not a second JSON layer. The official JSON plugin uses ESLint's native
language API and already parses JSON, JSONC, and JSON5. Avoid adding multiple
import sorters or a Prettier import-sorting plugin; choose one owner for import
ordering. There is no UI here to justify React, JSX accessibility, Vue, or
framework plugins.
[JSON language comparison](https://github.com/eslint/json#frequently-asked-questions),
[JSONC guide](https://ota-meshi.github.io/eslint-plugin-jsonc/user-guide/).

## Type-aware checks and project boundaries

High-value additions include `no-floating-promises`, `no-misused-promises`,
`await-thenable`, the `no-unsafe-*` family, `only-throw-error`, and explicit
`switch-exhaustiveness-check`. The last rule needs enabling separately; choose
options appropriate to the project's discriminated unions. Decide whether
`void promise` counts as intentionally detached work: `no-floating-promises`
allows it by default, but that does not handle a rejection. Worker background
work still requires correct lifetime/error handling.
[Floating promises](https://typescript-eslint.io/rules/no-floating-promises/),
[throw checks](https://typescript-eslint.io/rules/only-throw-error/),
[exhaustiveness](https://typescript-eslint.io/rules/switch-exhaustiveness-check/).

Prefer `projectService: true` once every TypeScript file has discoverable
project ownership. It uses the nearest ancestor `tsconfig.json`; this repo's
shared `src/` currently has no ancestor tsconfig, even though application
configs include it. Add deliberate root/shared ownership, or use scoped
`parserOptions.project` configurations until discovery is proven. Do not put
the whole repository in `allowDefaultProject`: it adds substantial cost,
disallows `**`, and defaults to a limit of eight files. Keep ordinary Node
scripts untyped unless intentionally placing them in a checked JS project.
[Parser/project service](https://typescript-eslint.io/packages/parser/).

In typed Vitest tests, replace `@typescript-eslint/unbound-method` with
`vitest/unbound-method`, which understands assertion usage. `settings.vitest.typecheck`
is for Vitest's optional type-testing assertions, not a general switch for
typed linting; do not set it merely because TypeScript tests exist.
[Vitest unbound-method](https://github.com/vitest-dev/eslint-plugin-vitest/blob/main/docs/rules/unbound-method.md),
[Vitest type-testing configuration](https://github.com/vitest-dev/eslint-plugin-vitest#enabling-with-type-testing).

## Preserve repository-specific coverage

These are design recommendations, not a claim of complete rule parity.
The current Biome recommended preset includes checks with no exact ESLint
counterpart, including `noImplicitAnyLet` and `noVoidTypeReturn`;
`noAccumulatingSpread` is valuable performance coverage to account for during
a detailed migration. Retain existing warning severities until findings are
deliberately resolved. Source: repository [Biome config](../../biome.jsonc)
and the [existing comparison](2026-09-10-lint-toolchain-comparison.md).

Biome explicitly lists these as its own rules in its
[rule source catalogue](https://biomejs.dev/linter/javascript/sources/).
The migration must map the enabled preset, overrides, and two existing inline
suppressions rule by rule. A small local rule or syntax restriction may be
appropriate for a remaining gap. TypeScript's `noImplicitAny` does not reproduce
[uninitialized-variable checks](https://biomejs.dev/linter/rules/no-implicit-any-let/javascript/).
Neither typescript-eslint's
[no-confusing-void-expression](https://typescript-eslint.io/rules/no-confusing-void-expression/)
nor [strict-void-return](https://typescript-eslint.io/rules/strict-void-return/)
should be described as an exact replacement for Biome's
[noVoidTypeReturn](https://biomejs.dev/linter/rules/no-void-type-return/javascript/).
They address related but different return-value patterns.

Keep `check:imports` initially. The bespoke checks enforce type-only cycles,
cluster/public-index direction, and D1/store/SQL restrictions that a generic
import preset does not reproduce. Worker configs use `nodejs_compat`, so a
blanket prohibition of Node built-ins would be incorrect. Source:
[package scripts](../../package.json),
[cycle guard](../../scripts/catalogue-import-cycles.mjs),
[boundary guard](../../scripts/catalogue-import-boundary.mjs),
[Worker config](../../apps/ingestion/wrangler.jsonc).

In particular, import-x's
[no-cycle](https://github.com/un-ts/eslint-plugin-import-x/blob/master/docs/rules/no-cycle.md)
ignores type-only imports, whereas the existing cycle guard intentionally counts
them. `eslint-plugin-boundaries` is a potential later replacement for the
cluster/public-index portion, after reproducing its contracts; it would not
automatically cover cycles or the store/SQL restrictions.
[Boundary plugin](https://github.com/javierbrea/eslint-plugin-boundaries).

Preserve the changed-file formatting ratchet, generated-file/fixture exclusions,
120-column width, two spaces, double quotes, semicolons, and all trailing commas.
Changing formatter will produce some different wrapping; do not combine a
repository-wide rewrite with the lint migration. Source:
[formatter wrapper](../../scripts/format.mjs), [Biome config](../../biome.jsonc).

An initial Prettier configuration preserving those preferences is:

```json
{
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "singleQuote": false,
  "semi": true,
  "trailingComma": "all",
  "endOfLine": "lf"
}
```

Prettier's width is a wrapping preference and its quote preference can yield
to fewer escapes; this does not promise byte-identical output.
[Prettier options](https://prettier.io/docs/options).

Keep the existing `lint`, `format`, `format:check`, and aggregate `check` task
interfaces. ESLint should check all maintained source; Prettier should use the
existing merge-base plus working-tree/untracked selection. Carry Git ignores
and the explicit Biome exclusions into both tools deliberately. Preserve
compiler, generated-file, import, and build checks and the required CI job IDs.
Enable unused-disable reporting; make new correctness checks errors after
reviewing their initial findings. A zero-warning gate is a suitable end state,
not compatible with retaining the current warning debt unchanged.
[ESLint configuration](https://eslint.org/docs/latest/use/configure/configuration-files),
[repository testing policy](../testing.md).

Optional additions should have a named purpose: import ordering via import-x
if desired, extra JSONC rules through the alternative JSONC plugin, or a later
architecture migration. Broad SonarJS/security/style bundles and additional
import/unused-variable plugins are not required to obtain the core benefit.
The owner subsequently clarified that approximate parity is sufficient and
prioritizes early bug detection. Exact rule-by-rule parity is therefore no
longer an adoption requirement. Selected non-overlapping SonarJS correctness
rules are worth evaluating under that priority.
[SonarJS rules](https://github.com/SonarSource/SonarJS/blob/master/packages/analysis/src/jsts/rules/README.md).
The proposed ESLint stack remains uninstalled. Validate the documented TS6/TS7
coexistence path (or choose TS6 alone), actual file/type coverage, useful
positive/negative lint probes, editor feedback, and the existing CI gates.
