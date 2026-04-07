# Documentation Website with Starlight on GitHub Pages

## Context and Problem Statement

The project has extensive markdown documentation in `docs/` but no deployed documentation site. Users discover docs only through GitHub file browsing, which limits discoverability and provides a suboptimal reading experience.

**Problem:** How should we publish project documentation as a public-facing website to improve discoverability and reading experience?

## Considered Options

* **Starlight (Astro)** — Purpose-built docs framework with built-in search, minimal config, excellent out-of-box docs experience. Astro's island architecture keeps pages fast.
* **VitePress** — Vue-based static site generator for docs. Good DX but less docs-specific defaults than Starlight.
* **Docusaurus** — React-based, feature-rich. Heavier; more suited to larger projects with complex needs.
* **Nextra** — Next.js-based docs framework. Ties into Next.js ecosystem; heavier runtime than Astro.

### Structural options considered

* **Symlinks from `website/` to `docs/`** — Rejected because Starlight requires frontmatter and links need rewriting for the site's routing structure.
* **`glob()` loader to read from external directory** — Not officially supported by Starlight's `docsLoader()`; fragile and undocumented.
* **Root-level integration (Astro deps in main `package.json`)** — Rejected to avoid dependency mixing between the action's runtime deps and the website's build deps.

## Decision Outcome

Chosen option: **"Starlight (Astro) hosted on GitHub Pages"**, because it provides the best out-of-box documentation experience with minimal configuration, built-in search, and a lightweight output. The website lives in an isolated `website/` directory with its own `package.json` to avoid dependency mixing with the main project.

Key structural decisions:

* **Copy-script approach:** `docs/` remains the single source of truth. A build-time script copies and transforms markdown files into Starlight-compatible content (frontmatter injection, link rewriting). This avoids content duplication in version control.
* **Artifact-based GitHub Pages deploy:** Uses the upload-artifact / deploy-pages pattern — no `gh-pages` branch to maintain.
* **Custom landing page:** A separate landing page outside Starlight's docs routing provides a project overview before entering the documentation.

### Consequences

* Good: Public documentation site with search, navigation, and a better reading experience.
* Good: Source of truth stays in `docs/` — contributors edit docs in one place; the website reflects those changes automatically at build time.
* Good: Isolated `website/` directory prevents dependency conflicts with the main project.
* Bad: Additional CI workflow and build step to maintain.
* Bad: The copy-and-transform script is custom code that needs maintenance when docs structure changes (new directories, changed link patterns).
