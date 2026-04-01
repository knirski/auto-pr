# PR Template

A single template at [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) serves both manual and automated PR creation.

## Usage

| Mode | How |
|------|-----|
| **Manual** | GitHub shows the template when creating a PR. Replace each `{{placeholder}}` with your content. Edit the **How to test** section as plain markdown (no `{{…}}` there). |
| **Automated** | `auto-pr-generate-content` runs FillPrTemplate for title and body; AI provider generates title and description for 2+ commits. Writes `pr-title.txt` and `pr-body.md` under the workspace. `auto-pr-create-or-update-pr` reads those files and calls `gh`. |

### Single-commit vs multi-commit (automated)

- **One commit on the branch:** The PR **description** comes from that commit’s message (body and subject rules as below). There is **no** AI summary step.
- **Two or more commits:** The workflow asks the model for a **title** and **description** that summarize the set. Fallbacks exist if the model fails; see implementation notes.

Polish the PR on GitHub if a commit message was too terse—the template reflects commits, it does not invent product context.

### Breaking changes: `feat!:` vs `BREAKING CHANGE:`

- **`feat!:` / `fix!:` / `type(scope)!:`** in the **subject** marks a breaking change and supplies a **short** summary (the text after `!:`) for `{{breakingChanges}}` when there is no footer.
- **`BREAKING CHANGE:` in the commit body** (footer) is the right place for **detailed** migration notes. Multiple footers across commits are combined in order.

## Placeholders

| Placeholder | Source |
|------------|--------|
| `{{description}}` | For 1 commit: first commit body (or subject after colon if body starts with Closes/Fixes); max 20 lines. For 2+ commits: AI summary (workflow) or concatenated bodies (fallback) |
| `{{typeOfChange}}` | Inferred from conventional commits (breaking notes, first commit’s type, etc.). **auto-pr-generate-content** passes the generated PR title into filling so this matches `pr-title.txt`. **fill-pr-template** uses the first commit subject unless you pass **`--pr-title`** (same role as the workflow title). |
| `{{changes}}` | One bullet per commit subject |
| *(How to test)* | Not a placeholder. Edit the **How to test** section in this file directly—default scaffold lists generic steps; replace with your project’s commands or `N/A` for docs-only/trivial changes. |
| `{{checklistConventional}}` | `x` or ` ` |
| `{{checklistDocs}}` | `x` or ` ` |
| `{{checklistTests}}` | `x` or ` ` |
| `{{relatedIssues}}` | `Closes #123` etc. from commits |
| `{{breakingChanges}}` | From commits: all `BREAKING CHANGE:` footers (in order); if none, text after `!:` on a breaking **PR title** when passed (workflow or **`--pr-title`**); else descriptions from commit subjects (`feat!:` / `feat(scope)!:` / lines starting with `BREAKING`). Empty when type is not Breaking change. |

## fill-pr-template CLI

Uses `effect/unstable/cli` (Command, Argument, Flag).

### Arguments

- **`--log-file PATH`:** (Required) Path to file containing commit log. Format: `---COMMIT---`-separated blocks (subject + body per commit). Generate via `git log --format="---COMMIT---%n%s%n%n%b" base..HEAD`.
- **`--files-file PATH`:** (Required) Path to file containing newline-separated changed file names. Generate via `git diff --name-only base..HEAD`.
- **`--template PATH`:** Override template file. Default: `.github/PULL_REQUEST_TEMPLATE.md` relative to cwd.
- **`--description-file PATH`:** Use file content as description (e.g. AI-generated). Overrides computed description.
- **`--pr-title TITLE`:** Optional conventional PR title. Drives `{{typeOfChange}}` and breaking summary the same way the workflow’s generated title does. With **`--format title-body`**, prints this as the **first line** of stdout instead of the first commit subject.
- **`--output-description-prompt`:** Output commit content for AI to summarize. Requires `--log-file` only. Used by auto-pr-generate-content (2+ commits).
- **`--format title-body`:** Output first line = PR title, blank line, then body. Title = first commit subject (1 commit) or AI-generated (2+ commits).
- **`--validate-title TITLE`:** Validate that the string is a conventional commit title; exit 0 if valid, 1 otherwise.
- **`--quiet`:** Suppress logs (for CI when capturing stdout).

### Template path

- **Default:** `.github/PULL_REQUEST_TEMPLATE.md` relative to current working directory.
- **With `--template`:** Relative paths resolved from cwd; absolute paths used as-is.

### Substitution

- Plain string replacement: `{{placeholder}}` → value.
- **Escaping:** Literal `{{` and `}}` in commit content are preserved.
- **Empty values:** `{{relatedIssues}}` and `{{breakingChanges}}` when empty → empty string.
- **Unreplaced warning:** If output still contains `{{` after substitution, a warning is logged to stderr.

## Behavior

- **Type of change vs title:** For automated runs with 2+ commits, the template’s **Type of change** is driven by the same conventional prefix as the generated PR title (`feat` → New feature, `fix` → Bug fix, …), not only the first commit in the log. For **fill-pr-template** outside Actions, pass **`--pr-title`** to match that behavior.
- **Merge commits:** Filtered from body and title input (subjects like `Merge branch 'x' into y` add no semantic value).
- **Non-conventional commits:** Included in body and as AI input; type falls back to "Chore".
- **Docs-only:** `isDocsOnly(files)` when only `.md` paths (etc.). Reviewers may still see the **How to test** scaffold—edit that section to `N/A` or delete steps when appropriate.
- **Checklist:** The "I have run `bun run check`" box has no placeholder — always unchecked. By design.
- **Cross-repo refs:** `owner/repo#123` format supported; deduplicated and sorted.

## Implementation notes

- **Git format:** Commit log uses `---COMMIT---` delimiter (`git log --format=---COMMIT---%n%s%n%b`). Changing this breaks parsing.
- **Description:** For 1 commit: first 20 lines of body. For 2+ commits: AI summarizes; fallback is concatenated bodies. Prose paragraphs unwrapped via remark AST; lists and code blocks preserved.
- **Breaking changes:** Truncated at 2000 chars.
