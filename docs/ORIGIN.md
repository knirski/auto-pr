# Origin

auto-pr was extracted from [paperless-ingestion-bot](https://github.com/knirski/paperless-ingestion-bot), where it powered the auto-PR workflow for AI-generated branches. Designed to be reusable in any repository.

## What was extracted

The module was self-contained in paperless-ingestion-bot: `scripts/auto-pr/` (config, core, errors, interfaces, live, prompts, shell, utils) plus sibling scripts (`fill-pr-template-core.ts`, `fill-pr-template.ts`, `collapse-prose-paragraphs.ts`, `auto-pr-get-commits.ts`, `generate-pr-content.ts`, `create-or-update-pr.ts`). It had no imports from `src/` (domain, shell, core).

## Source

- **Extraction guide:** [paperless-ingestion-bot/docs/auto-pr-extraction.md](https://github.com/knirski/paperless-ingestion-bot/blob/main/docs/auto-pr-extraction.md) — boundary, extraction steps, decoupled utilities
