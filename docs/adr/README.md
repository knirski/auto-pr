# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records for the auto-pr project.

## Format

Each ADR is a markdown file named `NNNN-title-with-dashes.md` where NNNN is a zero-padded number. See [adr-template.md](adr-template.md) for the template ([MADR 4.0.0 minimal](https://github.com/adr/madr/blob/4.0.0/template/adr-template-minimal.md)).

When creating or editing ADRs, follow the workflow in [AGENTS.md](../../AGENTS.md#adr-workflow).

## Index

| ADR  | Title |
| ---- | ----- |
| 0000 | [Template](adr-template.md) |
| 0001 | [Functional Core / Imperative Shell and Effect](0001-functional-core-imperative-shell.md) |
| 0002 | [Two-phase auto-PR workflow](0002-two-phase-auto-pr-workflow.md) |
| 0003 | [Bun as package manager and test runner](0003-bun-package-manager.md) |
| 0004 | [Workflow pin automation](0004-workflow-pin-automation.md) |
| 0005 | [Build and dist management](0005-build-and-dist-management.md) |
| 0006 | [Nix CI: upstream Nix and caching](0006-nix-ci-upstream-and-caching.md) |
| 0007 | [Config-driven AI provider abstraction](0007-ai-abstraction-layer.md) |
| 0008 | [Configuration: env vars; config file deferred](0008-config-file.md) |
| 0009 | [Ollama removal and OpenAI-compat-only `LanguageModel`](0009-ollama-to-openai-compat-migration.md) |
| 0010 | [Extract auto-pr from paperless-ingestion-bot](0010-extract-from-paperless-ingestion-bot.md) |
| 0011 | [GitContext service and AI diff tool use](0011-gitcontext-and-diff-tool-use.md) |
| 0012 | [Documentation website with Starlight on GitHub Pages](0012-documentation-website.md) |
| 0013 | [Transient vs permanent AI error classification](0013-transient-vs-permanent-ai-errors.md) |
| 0014 | [Replace gh PR wrapper with Octokit](0014-replace-gh-pr-wrapper-with-octokit.md) |

## Supporting documents (research and plans)

These documents inform or support decisions but are not ADRs. They live in [supporting/](supporting/):

| Document | Purpose |
| -------- | ------- |
| [bun-migration-plan.md](supporting/bun-migration-plan.md) | Plan: Bun migration (complete; see ADR 0003) |
| [build-plan-2026.md](supporting/build-plan-2026.md) | Plan: build tool research (tsdown vs Bun.build; implemented via Bun.build) |
| [determinate-nix-migration-plan.md](supporting/determinate-nix-migration-plan.md) | Plan: migration to Determinate Nix (if adopted) |
| [nix-ci-research.md](supporting/nix-ci-research.md) | Research: Nix CI best practices assessment |
| [nix-workflow-upstream-actions.md](supporting/nix-workflow-upstream-actions.md) | Research: replacing nix.yml steps with upstream actions |
| [workflow-best-practices.md](supporting/workflow-best-practices.md) | Research: GitHub Actions workflow best practices |
| [commit-ordering-for-ai-prompt.md](supporting/commit-ordering-for-ai-prompt.md) | Design: sort/filter commits by type before AI prompt to reduce position bias |
