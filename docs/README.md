# Documentation

## Structure

User-facing and contributor docs live at the top of `docs/` and are published to the website. ADRs under `docs/adr/` are also published, but historical supporting research and implementation plans remain repository-only unless a published page links to the GitHub source.

| Audience | Document | Purpose |
|----------|----------|---------|
| **Users (adopters)** | [INTEGRATION.md](INTEGRATION.md) | Add auto-pr to a repo — setup, GitHub App, workflow |
| | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |
| | [PR_TEMPLATE.md](PR_TEMPLATE.md) | Placeholders, fill-pr-template CLI, behavior |
| **Contributors** | [ARCHITECTURE.md](ARCHITECTURE.md) | Code structure, FC/IS, pipeline flow, glossary |
| | [CI.md](CI.md) | Workflows, branch protection, dist management |
| | [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md) | Two-phase design, threat model |
| | [ADR 0010](adr/0010-extract-from-paperless-ingestion-bot.md) | Extraction from paperless-ingestion-bot |
| | [CII.md](CII.md) | OpenSSF Best Practices badge progress |
| | [CONTRIBUTING.md](../CONTRIBUTING.md) | Development setup, commits, PRs |
| **Decisions** | [adr/](adr/) | Architecture Decision Records and supporting research |

## Publishing model

- Published to the documentation website: top-level `docs/*.md` except this index, plus top-level ADRs in `docs/adr/`.
- Linked as GitHub source from the website: workflow/action files, root files such as `CONTRIBUTING.md`, ADR supporting research, and `docs/superpowers/` design artifacts.
- Canonical operational references: [INTEGRATION.md](INTEGRATION.md) for adopters, [CI.md](CI.md) for workflow behavior, [ARCHITECTURE.md](ARCHITECTURE.md) for code structure.

## Quick links

- **Setting up auto-pr:** [INTEGRATION.md](INTEGRATION.md)
- **Something broken?** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **How the code is structured:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **CI and workflows:** [CI.md](CI.md)
- **Security model:** [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md)
- **Why we chose X:** [adr/README.md](adr/README.md)
