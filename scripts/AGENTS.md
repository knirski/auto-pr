# Script Instructions

These rules apply to `scripts/**` and shell entrypoints in `.github/actions/**`.

## Shell Scripts

- Run `bun run lint:scripts` after editing `.sh` files.
- Use `bun run format:scripts` for formatting fixes.
- Keep scripts portable Bash unless a file already documents a narrower runtime.
- Quote expansions, use arrays for argv construction, and prefer explicit failure messages.
- Never echo secrets or values derived from `Redacted.value()`.

## TypeScript Scripts

- `scripts/act-local-ci.ts` is the only scoped FC/IS exception: it may keep pure helpers beside the imperative CLI because it is a dev-tool harness.
- Do not extend that exception to application code. New reusable pure logic belongs in `src/core/*.ts`; shell orchestration belongs in `src/workflow/*.ts`, `src/tools/*.ts`, or `src/auto-pr/shell.ts`.
- Use Bun to run scripts (`bun scripts/<name>.ts` or `bun run <script>`), not `npx`, except in adopter-facing documentation.
