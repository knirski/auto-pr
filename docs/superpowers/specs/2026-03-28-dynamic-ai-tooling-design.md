# Dynamic AI Tooling for Repository Exploration

**Date:** 2026-03-28  
**Status:** Proposed / Documented for future  
**Summary:** Transition from a "static context" model (where all repo data is pushed to the AI) to an "on-demand exploration" model using Effect's new AI Toolkit and Dynamic Tooling capabilities.

## 1. Context and Goals

### Current State
- **Process:** The workflow is split into two distinct phases:
    1. `auto-pr-get-commits.ts`: Manually executes shell commands (`git log`, `git diff`) and writes the entire output to temporary files.
    2. `auto-pr-generate-content.ts`: Reads these files and "dumps" their entire content into the AI prompt as a single block of text.
- **Limitations:**
    - **Context Window Waste:** Large PRs with many commits or massive diffs can exceed the AI's context limit or increase latency/cost unnecessarily.
    - **Inflexible Analysis:** The AI can only see exactly what the pre-processing script provides. It cannot "decide" to look at a related file, check a `README.md` for context, or drill down into a specific commit's changes.
    - **Complex Pipeline:** Requires maintaining state via temporary files between workflow steps.

### Goals
- **On-Demand Context:** Empower the AI to fetch only the data it needs to understand the PR.
- **Exploratory Analysis:** Allow the AI to navigate the repository (read files, check history) to produce higher-quality descriptions.
- **Architectural Simplification:** Merge the "gathering" and "generating" phases into a single intelligent operation.

## 2. Proposed Design

### Effect AI Toolkits (beta.42+)
Leverage the new `AiToolkit` and `LanguageModel` features in Effect v4 beta to define a "Repository Toolkit".

#### Example Toolkit Definition
```typescript
import { AiToolkit } from "effect/unstable/ai";
import { Schema } from "effect";

const RepoToolkit = AiToolkit.make({
  getCommitHistory: AiToolkit.tool(
    "Returns the list of recent commit subjects and SHAs for the current branch",
    Schema.Void,
    () => runGitLogSubjects() // Returns light metadata
  ),
  getCommitDiff: AiToolkit.tool(
    "Returns the full diff for a specific commit SHA",
    Schema.Struct({ sha: Schema.String }),
    ({ sha }) => runGitDiffForCommit(sha)
  ),
  getFileContent: Schema.tool(
    "Reads the content of a file at a specific path",
    Schema.Struct({ path: Schema.String }),
    ({ path }) => fs.readFileString(path)
  )
});
```

### New Data Flow
1. **Initial Prompt:** "I am preparing a PR description. Here are the commit subjects: [LIST]. Use the provided tools to examine specific diffs or files as needed to write a comprehensive summary."
2. **AI Reasoning:** The AI reviews the subjects and notices a change in `src/core/errors.ts`.
3. **Tool Call:** The AI calls `getFileContent({ path: "src/core/errors.ts" })` to see how error handling changed.
4. **Final Output:** The AI generates the title and body based on its targeted exploration.

## 3. Benefits

- **Efficiency:** Drastic reduction in prompt size for large PRs.
- **Quality:** The AI can perform "cross-file" analysis (e.g., "This change in the core affects the CLI flags in `tools/`").
- **Reliability:** No more "truncated context" issues where the most important part of a diff is lost at the end of a massive text dump.

## 4. Implementation Roadmap

### Phase 1: Infrastructure (Bridge)
- Create `src/auto-pr/live/repo-toolkit.ts`.
- Wrap existing `git` shell commands into Effect-based tool functions.

### Phase 2: AI Integration
- Update `generatePrContentFromValues` to accept and provide the `RepoToolkit` to the `LanguageModel`.
- Update prompts in `src/auto-pr/prompts/` to encourage tool usage.

### Phase 3: Workflow Consolidation
- Optional: Deprecate `auto-pr-get-commits.ts` as a standalone step in the GitHub Action, moving its logic entirely into the tools provided to the generator.

## 5. Implementation Notes
- **Security:** Tools must be read-only to prevent the AI from accidentally modifying the repository during analysis.
- **Provider Support:** Ensure that `OllamaLanguageModel` and `OpenAiLanguageModel` both correctly implement the tool-calling protocol (Ollama requires specific prompt formatting or the `format: 'json'` parameter).
- **Caching:** Consider caching tool results (like file content) within a single Effect run to avoid redundant disk I/O.
