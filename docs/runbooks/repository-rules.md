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
- Merge queue on: squash, all-green grouping, build 3, merge 1–3 entries,
  5-minute wait, 60-minute check timeout. `ci.yml` and `pr-title.yml` both
  trigger on `merge_group`.
- Linear history required. Force pushes and deletion blocked.

## Tags and environments

| Target                     | Rule                                                             |
| -------------------------- | ---------------------------------------------------------------- |
| `refs/tags/v*`             | No update, force-move or deletion, admins included               |
| `dev` environment          | Deploys only from `main` (`dev-deploy.yml` runs after `main` CI) |
| `staging` and `production` | Deploy only from `v*` tags, once the tag-driven workflows exist  |

GitHub refuses the built-in GitHub Actions app as a ruleset bypass actor. So a
tag-creation rule would also block release-please, which tags with
`GITHUB_TOKEN`. Restricting `v*` creation to release-please requires a dedicated
GitHub App and its key as a new secret. That credential change is an owner
decision. Until then, any writer can create a `v*` tag. Any workflow that acts on
a tag must verify that release-please created it: a GitHub Release by
`github-actions[bot]` on a `chore: release` squash commit contained in `main`.

The tag-only policy for `staging` and `production` must wait for the workflows
that dispatch with `--ref vX.Y.Z`. Applied earlier, it would refuse today's
`main`-dispatched manual staging and production releases.

## Order of application

1. Merge the PR that adds `pr-title.yml`. Every required check must exist on
   `main` first; otherwise pull requests wait for a check that never reports.
2. Merge and branch settings, then Actions permissions.
3. Create the `main` ruleset. Check that its rules are listed for `main`, then
   delete the classic protection rule, whose `strict: true` would otherwise keep
   requiring up-to-date branches.
4. Create the tag ruleset and the `dev` environment policy.
5. Add the `staging`/`production` tag policy only with tag-driven releases.

The owner script is kept in ignored `.artifacts/238/owner-repo-rules.sh`. It has
one subcommand per step and a `verify` read-back for #238. Its endpoint and field
names were checked against GitHub's REST OpenAPI description; it holds no secrets.

References: [rulesets API](https://docs.github.com/en/rest/repos/rules),
[repository update API](https://docs.github.com/en/rest/repos/repos#update-a-repository),
[deployment branch policies](https://docs.github.com/en/rest/deployments/branch-policies),
[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue),
[`GITHUB_TOKEN` triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).
