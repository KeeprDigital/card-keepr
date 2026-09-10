# Issue #301 implementation review

Reviewed commit `08e121fc` against baseline
`cdff6f198bc7332a4dc89b2adf1a43b9d261d212` with the code-review skill's
independent Standards and Spec agents. Full local and hosted validation was
running during review; final evidence belongs in the
[validation record](../evidence/toolchain-301.md).

## Standards

No documented-standard violations found. The diff preserves test tiers,
concurrency, deadlines, native build approval, dependency separation and
Production Release guards.

One judgment call: possible Duplicated Code in the setup/cache/install block,
repeated ten times across six workflows. The reviewer suggested a repository
composite action to centralize cache policy. This is a maintenance suggestion,
not a hard standards breach. The implementation retains the existing explicit
workflow step structure and SHA-pinned action checks, with executable Corepack
setup shared in `scripts/setup-pnpm.sh`. Consolidating the workflow declarations
remains optional; it does not block this migration.

## Spec

No implementation defects or unwanted scope found. The pnpm/Corepack migration
preserves dependency versions, the scoped parse5 override, compiler and test
commands, release guards, workflow identities/shards and formatting behavior.
Retaining Biome follows the explicit conditional fallback; the evidence clearly
records the JSON/JSONC blocker and uncompleted Vite+ trial requirements.

The review identified completion evidence still needed: posting the blocker to
the issue, recording cache-miss/cache-hit and ready-PR full CI results, and
recording actual main-commit CI after merge. The
[blocker report](https://github.com/KeeprDigital/card-keepr/issues/301#issuecomment-5617842958)
is now posted. CI results are tracked in the validation record. Main-commit CI
remains a post-merge requirement and is not replaced by diagnostic runs.

Standards: zero hard violations, one optional maintenance suggestion. Spec:
zero implementation findings, with validation completion tracked separately.

## Follow-up: owner-requested current releases

The owner superseded the issue's Node 22 constraint and selected Node 26.8.2,
Corepack 0.36.0 and pnpm 12.3.4. A second independent Spec review found the
new pnpm settings and runtime ownership correct. pnpm 12's leading
package-manager lockfile document is expected metadata.

The review identified an incorrect Vite importer reference while the dependency
fix was in progress: it pointed to the bare version instead of the retained
peer-qualified snapshot. pnpm's lockfile repair corrected it without changing
application package versions, and the three existing acceptance files passed
all four tests afterwards. This finding is resolved. Validation on the newly
selected versions is tracked in the evidence record, separately from the
superseded Node 22 runs.

The Standards follow-up review of `08e121fc...982af78f` found zero new hard
violations or smells. The previously acknowledged optional CI declaration
duplication remains the only maintenance suggestion.
