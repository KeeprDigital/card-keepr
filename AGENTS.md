# Repository guidance

- Before exploring domain behavior, read [CONTEXT.md](CONTEXT.md) and the relevant
  section of [architecture](docs/architecture.md). Use the glossary's vocabulary;
  surface conflicts with accepted decisions. The [code map](src/catalogue/README.md)
  describes module ownership and import boundaries.
- Before selecting checks, adding tests or changing CI, read [docs/testing.md](docs/testing.md).
- Track issues, PRDs and work status in GitHub Issues for `KeeprDigital/card-keepr`.
  Use `gh` for tracker operations; read the issue body, comments and labels.
  GitHub shares issue/PR numbers, so resolve an ambiguous number before acting.
  PRs are code reviews, not a feature-request intake surface.
- Canonical triage labels: `needs-triage` (unassessed), `needs-info` (reporter input),
  `ready-for-agent`, `ready-for-human`, and `wontfix`.

## Documentation

[README.md](README.md) is the documentation index. Keep one maintained source per
subject and update it in place. Keep the glossary about domain meaning, interface
contracts under `contracts/`, and operational procedures under `docs/runbooks/`.
Record enduring design decisions in `docs/architecture.md`, with an issue link
when the full decision needs context. Distinguish accepted direction from shipped
behavior. Package scripts, schemas and configuration own exact executable details.

Put temporary plans, review notes, logs and measurements in ignored `.artifacts/`.
Keep task progress and validation reports with the GitHub issue or PR when posting
is authorized. Do not accumulate local issue copies, dated audit diaries or
competing guides. Update callers and links when consolidating documentation.
