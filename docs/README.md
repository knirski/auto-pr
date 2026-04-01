# Documentation

## Structure

| Audience | Document | Purpose |
|----------|----------|---------|
| **Users (adopters)** | [INTEGRATION.md](INTEGRATION.md) | Add auto-pr to a repo — setup, GitHub App, workflow |
| | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Common issues and fixes |
| | [PR_TEMPLATE.md](PR_TEMPLATE.md) | Placeholders, fill-pr-template CLI, behavior |
| **Contributors** | [CONCEPTS.md](CONCEPTS.md) | Glossary of terms (FC/IS, Tagless Final, etc.) |
| | [ARCHITECTURE.md](ARCHITECTURE.md) | Code structure, FC/IS, pipeline flow |
| | [CI.md](CI.md) | Workflows, branch protection, dist management |
| | [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md) | Two-phase design, threat model |
| | [ORIGIN.md](ORIGIN.md) | Extraction from paperless-ingestion-bot |
| | [CII.md](CII.md) | OpenSSF Best Practices badge progress |
| | [CONTRIBUTING.md](../CONTRIBUTING.md) | Development setup, commits, PRs |
| **Decisions** | [adr/](adr/) | Architecture Decision Records and supporting research |
| **Design specs** | [superpowers/specs/](superpowers/specs/) | Pre-implementation designs |

### AI design (2026-03-29)

| Order | Doc | Purpose |
|-------|-----|---------|
| 1 | [ADR 0009](adr/0009-ollama-to-openai-compat-migration.md) · [spec stub](superpowers/specs/2026-03-29-ollama-to-llamacpp-migration-design.md) | `local` + `github-models`; one OpenAI-compat path (Ollama removed) |
| — | [2026-03-29-dynamic-ai-tooling-design.md](superpowers/specs/2026-03-29-dynamic-ai-tooling-design.md) | Index — which doc for which task |
| 2+ | [2026-03-29-auto-pr-inference-and-routing.md](superpowers/specs/2026-03-29-auto-pr-inference-and-routing.md) | Env, metrics, model selection, prompt placeholders |
| 2+ | [2026-03-29-auto-pr-effect-toolkit-design.md](superpowers/specs/2026-03-29-auto-pr-effect-toolkit-design.md) | `Tool`/`Toolkit`, phases, `generateObject` vs tools |

Historical pointer: [2026-03-22-ai-abstraction-layer-design.md](superpowers/specs/2026-03-22-ai-abstraction-layer-design.md) — superseded for provider ids; see [ADR 0007](adr/0007-ai-abstraction-layer.md).

## Quick links

- **Setting up auto-pr:** [INTEGRATION.md](INTEGRATION.md)
- **Something broken?** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **How the code is structured:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **CI and workflows:** [CI.md](CI.md)
- **Security model:** [WORKFLOW_SECURITY.md](WORKFLOW_SECURITY.md)
- **Why we chose X:** [adr/README.md](adr/README.md)
