# Repository rules

The owner chose these GitHub settings for the release front door on
[#238](https://github.com/KeeprDigital/card-keepr/issues/238) (2026-09-21).
This page records the chosen values and their order of application. Repository
tests cannot prove GitHub settings: the owner applies them, then posts the
`gh api` read-back on #238 as evidence. Until that read-back is posted, treat
these values as accepted direction, not applied state.

## Merges and branches

| Setting                                      | Value                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| Merge methods                                | Squash only; merge commits and rebase merges disabled          |
| Squash commit title / body                   | PR title / PR body                                             |
| PR title                                     | Conventional commit, enforced by the required `pr-title` check |
| Delete head branch on merge                  | On                                                             |
| Allow auto-merge                             | On; `gh pr merge --squash` joins the merge queue through it    |
| Agent branches                               | `codex/<issue>-<slug>`                                         |
| Release branch                               | `release-please--*`, reserved for release-please's release PR  |
| Default `GITHUB_TOKEN` permission            | Read; every workflow declares its own permissions              |
| Actions may create and approve pull requests | On, so release-please can open the release PR                  |
| Commit signing                               | Not required; optional later                                   |

## `main` ruleset

One active branch ruleset on the default branch, with **no bypass actors**, so
admins are bound too. It replaces the classic branch protection rule.

- Pull request required. 0 approvals (single owner). Conversation resolution
  required. Allowed merge method: squash.
- Required checks from GitHub Actions (integration `15368`): `lint`, `checks`,
  `domain-tests`, `ingestion-tests (1..4)`, `acceptance (1..3)` and `pr-title`.
  The ten `ci.yml` checks equal `production-release.yml`'s `REQUIRED_CI_CHECKS`.
  "Require branches to be up to date" is off because the merge queue replaces it
  (#374).
- For documentation-only pull requests and queue candidates, `ci.yml` skips the
  domain, ingestion and acceptance work but still reports all ten checks (#401).
  `domain-tests` is skipped, which satisfies a required check. The matrix shards
  succeed with a no-op step, because GitHub reports a matrix job skipped at job
  level as one unsuffixed check (`ingestion-tests`), and the required
  `ingestion-tests (1)` would never report. A `push` to `main` always runs every
  check, so the release gates see successful checks. The classifier job
  `changes` is not a required check.
- Merge queue on: squash, all-green grouping, build 3, merge 1–3 entries,
  5-minute wait, 60-minute check timeout. `ci.yml` and `pr-title.yml` both
  trigger on `merge_group`. The queued run executes on the SHA that lands, so
  exact-commit release gates bind checks to the named `push` CI run's check
  suite rather than counting all check runs on the commit.
- Linear history required. Force pushes and deletion blocked.

## Tags and environments

| Target                             | Rule                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `refs/tags/v*`                     | No update, force-move or deletion, admins included                                                       |
| `dev` environment                  | Deploys only from `main` (`dev-deploy.yml` runs after `main` CI)                                         |
| `production-promotion` environment | Required reviewer `then3rdman`; self-review allowed; no wait timer; deploys only from `main`; no secrets |
| `staging` and `production`         | Deploy only from `main`; **no** required reviewers                                                       |

The owner decision on
[#238](https://github.com/KeeprDigital/card-keepr/issues/238#issuecomment-5772735751)
requires exactly one human approval per path to production:

- **Automatic promotion:** the `production-promotion` reviewer approves the
  `promote` job of `staging-deploy.yml` (`pnpm release:approve` or the run page).
  The job's `production` executor then runs without another gate.
- **Manual `pnpm release:production`:** the CLI's exact-envelope `y/N` is the
  approval. A reviewer on `production` would add a second one, so `production`
  has none.

Self-review must stay allowed: the owner dispatches the staging run and is the
only collaborator, so "prevent self-review" would leave no one able to approve.
If a workflow names an environment that does not exist, GitHub creates it
without protection. The `promote` job therefore fails closed unless the run
records an approved `production-promotion` review, and the environment must be
configured before the first staging release that uses the wiring.

All three release workflows run on `main` (the staging and production workflows
are dispatched on `main`, and the promotion calls the executor from that run),
so `main` is the branch policy for `staging`, `production` and
`production-promotion`. This replaces the earlier tag-only plan, which the lean
scope dropped.

GitHub refuses the built-in GitHub Actions app as a ruleset bypass actor. So a
tag-creation rule would also block release-please, which tags with
`GITHUB_TOKEN`. Restricting `v*` creation to release-please requires a dedicated
GitHub App and its key as a new secret. That credential change is an owner
decision. Until then, any writer can create a `v*` tag. Any workflow that acts on
a tag must verify that release-please created it: a GitHub Release by
`github-actions[bot]` on a `chore: release` squash commit contained in `main`.

## Order of application

1. Merge the PR that adds `pr-title.yml`. Every required check must exist on
   `main` first; otherwise pull requests wait for a check that never reports.
2. Merge and branch settings, then Actions permissions.
3. Create the `main` ruleset. Check that its rules are listed for `main`, then
   delete the classic protection rule, whose `strict: true` would otherwise keep
   requiring up-to-date branches.
4. Create the tag ruleset and the `dev` environment policy.
5. Before the first staging release after the promotion wiring merges, create
   `production-promotion` with its reviewer and `main` policy, and set the `main`
   policy on `staging` and `production`.

The owner scripts are kept in ignored `.artifacts/238/`: `owner-repo-rules.sh`
(steps 2–4) and `owner-promotion-env.sh` (step 5). Each has one subcommand per
step and a `verify` read-back for #238. Their endpoint and field names were
checked against GitHub's REST OpenAPI description; they hold no secrets.

References: [rulesets API](https://docs.github.com/en/rest/repos/rules),
[repository update API](https://docs.github.com/en/rest/repos/repos#update-a-repository),
[deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies),
[environments](https://docs.github.com/en/rest/deployments/environments),
[reviewing deployments](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run),
[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
[`GITHUB_TOKEN` triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
