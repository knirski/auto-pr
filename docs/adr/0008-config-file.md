# Configuration: environment variables (config file deferred)

## Status

**Current decision:** Keep **environment variables** as the configuration mechanism—including the small AI surface (~five `AUTO_PR_AI_*` keys plus secrets in env). Reusable workflows continue to map `inputs` → `env`. **No `auto-pr.config.json`** for now.

The sections under [Deferred: optional config file (future)](#deferred-optional-config-file-future) record a design we may revisit if in-repo defaults or Effect Schema validation for the AI block becomes worth the complexity.

## Context and Problem Statement

auto-pr uses many env vars in CI (pipeline plumbing: `GITHUB_OUTPUT`, paths implied by `GITHUB_WORKSPACE`, etc.)—those stay. **User-facing preferences** for AI are small: about **five** keys (`AUTO_PR_AI_PROVIDER` plus provider-specific model/URL fields; secrets stay in env). That surface is manageable.

We considered centralizing AI settings in a JSON file (commit defaults, Effect Schema validation, less repeated `env:` in workflows). **For now**, env-only is enough.

PR template path and “how to test” wording are **not** solved by extra env or a config file—use GitHub’s conventional template path and edit the template markdown for project-specific instructions (see [Convention: PR template and how to test](#convention-pr-template-and-how-to-test)).

## Decision Outcome

**Chosen option (now):** **Environment variables** only, as documented in [`src/auto-pr/config.ts`](../../src/auto-pr/config.ts), reusable workflows, and INTEGRATION.md.

**Deferred option:** Optional `auto-pr.config.json` with env override and Effect Schema validation—see below.

### Consequences (env-only)

* **Good:** CI-native; no new file format; matches current `config.ts` and tests.
* **Good:** ~five AI-related vars are easy to document and override per job.
* **Neutral:** Workflows may repeat the same `env:` block; acceptable until a file-based approach is needed.

### Consequences (if we later add a config file)

* **Good:** Commit AI defaults in-repo; optional Schema validation; fewer exports for local runs.
* **Bad:** Another artifact to maintain and explain (lookup order, migration).

## Convention: PR template and how to test

**PR template path:** `.github/PULL_REQUEST_TEMPLATE.md` relative to the repo root (GitHub standard). In code this is always `join(GITHUB_WORKSPACE, ".github/PULL_REQUEST_TEMPLATE.md")`—no env var, no shared constant; the path is documented here and in INTEGRATION.md / README.

**Generated title and body files:** `generate-content` writes `join(GITHUB_WORKSPACE, "pr-title.txt")` and `join(GITHUB_WORKSPACE, "pr-body.md")`. `create-or-update-pr` reads those paths (no `TITLE` / `BODY_FILE` env).

**“How to test”:** Users **edit** `.github/PULL_REQUEST_TEMPLATE.md` for project-specific steps (static markdown in the **How to test** section). **`AUTO_PR_HOW_TO_TEST` / workflow `auto_pr_how_to_test` are removed**; the stock template ships a generic scaffold; nothing is injected from code.

---

## Deferred: optional config file (future)

The following is **not implemented**. It remains reference material.

### Problem (original)

How can we centralize and validate the AI configuration surface while preserving CI compatibility, secrets in env, and backwards compatibility?

### Considered options (original)

* **Config file (JSON in repo)** — `auto-pr.config.json` in repo root; env overrides.
* **Config file (TOML)** — Same idea; heavier parse.
* **Dotenv only** — Often gitignored; mixes secrets with non-secrets.
* **Workflow inputs only, no file** — Current direction (see Decision Outcome above).
* **Single structured env var** — `AUTO_PR_CONFIG='{...}'`; poor DX.

### Design sketch

#### File location and discovery

- **Path:** `{GITHUB_WORKSPACE}/auto-pr.config.json` (repo root).
- **Optional:** Also check `.auto-pr.json`.
- **If missing:** Env-only (same as today).

#### Schema (AI block only, non-secret)

```json
{
  "ai": {
    "provider": "ollama",
    "ollama_model": "llama3.1:8b",
    "github_model": "",
    "openai_compat": {
      "url": "",
      "model": ""
    }
  }
}
```

**PR template path** and **how-to-test copy** would not live in this file—same conventions as [above](#convention-pr-template-and-how-to-test).

#### Field constraints (when provider = X)

| When `ai.provider` is | Required from config/env | Optional | Ignored |
|----------------------|--------------------------|----------|---------|
| `ollama`             | —                        | `ai.ollama_model` (default: `llama3.1:8b`) | `ai.github_model`, `ai.openai_compat` |
| `github-models`      | `ai.github_model`, `GH_TOKEN` (env) | — | `ai.ollama_model`, `ai.openai_compat` |
| `openai-compat`      | `ai.openai_compat.url`, `ai.openai_compat.model`, `AUTO_PR_AI_OPENAI_COMPAT_API_KEY` (env) | — | `ai.ollama_model`, `ai.github_model` |

**XOR:** Only one provider is active; validate after `provider` is resolved.

#### Enforcement (Effect Schema, if implemented)

Validate file + merged config with **Effect Schema** (`Schema.Struct` / `Schema.Union` on `provider`), `Schema.decodeUnknownEffect`, map `ParseError` → `AutoPrConfigError`. Secrets stay validated via `Redacted` / env-only checks.

#### What would not go into a future config file

Secrets (`GH_TOKEN`, `AUTO_PR_AI_OPENAI_COMPAT_API_KEY`), pipeline plumbing (`GITHUB_OUTPUT`, workspace-relative files from `get-commits`, …), runtime (`NO_COLOR`, `AUTO_PR_DEBUG`), internal script vars (`AUTO_PR_PKG`, …). See earlier drafts for full tables.

#### Env keys mirrored by a future file

| Config key               | Env (override)                    | Default   |
|--------------------------|-----------------------------------|-----------|
| `ai.provider`            | `AUTO_PR_AI_PROVIDER`             | `ollama`  |
| `ai.ollama_model`        | `AUTO_PR_AI_OLLAMA_MODEL`         | `llama3.1:8b` |
| `ai.github_model`        | `AUTO_PR_AI_GITHUB_MODEL`         | —         |
| `ai.openai_compat.url`   | `AUTO_PR_AI_OPENAI_COMPAT_URL`    | —         |
| `ai.openai_compat.model` | `AUTO_PR_AI_OPENAI_COMPAT_MODEL`  | —         |

**Override order (if file exists):** env → file → built-in default.

#### Future implementation sketch

1. `AutoPrConfigFileSchema` + merge with env + `ResolvedAiConfigSchema` union.
2. Integrate with `config.ts` layers.
3. Optional: `auto-pr-init` scaffolds JSON; optional JSON Schema for editors only.

#### Future migration (if the file is added)

* Phase 1: Add file support; env continues to work.

## References

* Current config: `src/auto-pr/config.ts`
* ADR 0007: AI abstraction (provider selection)
* INTEGRATION.md: Workflow setup
* Effect Schema (deferred design): `effect/Schema` — `Schema.Struct`, `Schema.Union`, `Schema.decodeUnknownEffect`, `ParseError`
