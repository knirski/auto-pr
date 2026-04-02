# Extract auto-pr from paperless-ingestion-bot

## Context and Problem Statement

The auto-PR workflow in [paperless-ingestion-bot](https://github.com/knirski/paperless-ingestion-bot) was a self-contained module (`scripts/auto-pr/`) with no imports from the host project's `src/`. It powered AI-generated branch-to-PR automation. Other repositories needed the same workflow, so the module needed to become a standalone project.

## Considered Options

* Keep as a directory in paperless-ingestion-bot and copy between repos
* Extract to a standalone repository with reusable workflows

## Decision Outcome

Chosen option: "Extract to a standalone repository", because the module was already self-contained (no cross-repo imports, decoupled utilities) and reusable workflows allow any GitHub repository to adopt auto-pr without copying code.

### Consequences

* Good, because any GitHub project can adopt auto-pr via reusable workflows and `npx`
* Good, because the module gets its own CI, versioning, and issue tracking
* Good, because the boundary was already clean — no refactoring of paperless-ingestion-bot required
* Neutral, because the structure moved from `scripts/auto-pr/` to `src/` for clearer separation from shell scripts

## Source

Extraction guide documented in paperless-ingestion-bot at extraction time. See [paperless-ingestion-bot](https://github.com/knirski/paperless-ingestion-bot) for the source repository.
