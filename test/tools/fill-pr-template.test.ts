import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { FillPrTemplate, renderBody } from "#auto-pr";
import type { CommitInfo } from "#core/fill-pr-template-core.js";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import {
	CliLayer,
	fillCommand,
	handleOutputDescriptionPrompt,
	handleValidateTitle,
	runFillBody,
} from "#tools/auto-pr-fill-pr-template.js";
import pkg from "../../package.json" with { type: "json" };

const TEST_TEMPLATE = `## Description
{{description}}

## Type of change
**{{typeOfChange}}**. See [Conventional Commits](https://www.conventionalcommits.org/).

## Changes made
{{changes}}

## How to test

1. Run \`npm run check\`
2. 

## Checklist
- [{{checklistConventional}}] My commits follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] I have run \`npm run check\` and fixed any issues
- [{{checklistDocs}}] I have updated the documentation if needed
- [{{checklistTests}}] I have added or updated tests for my changes

## Related issues
{{relatedIssues}}

## Breaking changes
{{breakingChanges}}
`;

const commit = (
	subject: string,
	body: string,
	opts?: { type?: string; references?: string[]; breakingNote?: string | null },
): CommitInfo => ({
	subject,
	body,
	fullMessage: `${subject}\n\n${body}`.trim(),
	type: opts?.type ?? null,
	references: opts?.references ?? [],
	breakingNote: opts?.breakingNote ?? null,
});

/** Format commit blocks for parseCommits (---COMMIT--- separated). */
function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

/** Write log and files to temp dir, run runFillBody, return output. No git. */
function runWithLogAndFilesEffect(
	logStr: string,
	filesStr: string,
	opts?: {
		templatePath?: string;
		format?: "body" | "title-body";
	},
): Effect.Effect<string, Error> {
	return Effect.gen(function* () {
		const tmp = yield* createTestTempDirEffect("fill-pr-template-");
		const templatePath = opts?.templatePath ?? tmp.join("template.md");
		if (opts?.templatePath === undefined) {
			yield* tmp.writeFile(templatePath, TEST_TEMPLATE);
		}
		return yield* Effect.gen(function* () {
			yield* tmp.writeFile(tmp.join("commits.txt"), logStr);
			yield* tmp.writeFile(tmp.join("files.txt"), filesStr);
			return yield* runFillBody(
				tmp.join("commits.txt"),
				tmp.join("files.txt"),
				templatePath,
				opts?.format ?? "body",
			);
		}).pipe(Effect.ensuring(tmp.remove()));
	}).pipe(Effect.provide(TestBaseLayer), Effect.provide(FillPrTemplate.Live));
}

// ─── renderBody (Effect wrapper) ─────────────────────────────────────────────

describe("renderBody", () => {
	test("returns rendered body when all placeholders replaced", async () => {
		await runEffect(SilentLoggerLayer)(
			Effect.gen(function* () {
				const commits = [commit("feat: add x", "Description here", { type: "feat" })];
				const files = ["src/foo.ts"];
				const body = yield* renderBody(commits, files, TEST_TEMPLATE, undefined);
				expect(body).toContain("## Description");
				expect(body).toContain("Description here");
				expect(body).not.toContain("{{description}}");
			}),
		);
	});

	test("returns body and logs warning when output contains {{", async () => {
		await runEffect(SilentLoggerLayer)(
			Effect.gen(function* () {
				const commits = [commit("feat: add x", "Use {{ and }} in your code", { type: "feat" })];
				const files = ["src/foo.ts"];
				const body = yield* renderBody(commits, files, TEST_TEMPLATE, undefined);
				expect(body).toContain("Use {{ and }} in your code");
				expect(body).toContain("{{");
			}),
		);
	});
});

const RunFillBodyTestLayer = Layer.mergeAll(TestBaseLayer, FillPrTemplate.Live);

describe("runFillBody", () => {
	test("produces full PR body from log and files", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent({ subject: "feat: add foo", body: "This adds the foo module." });
				const output = yield* runWithLogAndFilesEffect(log, "src/foo.ts\n");
				expect(output).toContain("## Description");
				expect(output).toContain("## Type of change");
				expect(output).toContain("## Changes made");
				expect(output).toContain("New feature");
				expect(output).toContain("feat: add foo");
				expect(output).toContain("This adds the foo module");
				expect(output).toContain("npm run check");
			}),
		));

	test("title-body format: first line is title (first commit subject)", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent({ subject: "feat(ci): add PR title generation", body: "" });
				const output = yield* runWithLogAndFilesEffect(log, "src/ci.ts\n", {
					format: "title-body",
				});
				const lines = output.split("\n");
				expect(lines[0]).toBe("feat(ci): add PR title generation");
				expect(lines[1]).toBe("");
				expect(output).toContain("## Description");
			}),
		));

	test("multi-commit: body includes all commits, title from first (newest)", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent(
					{ subject: "feat: add module B", body: "" },
					{ subject: "feat: add module A", body: "" },
				);
				const output = yield* runWithLogAndFilesEffect(log, "src/a.ts\nsrc/b.ts\n", {
					format: "title-body",
				});
				expect(output.split("\n")[0]).toBe("feat: add module B");
				expect(output).toContain("feat: add module A");
				expect(output).toContain("feat: add module B");
				expect(output).toContain("## Changes made");
			}),
		));

	test("multi-commit: description concatenates all commit bodies", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent(
					{ subject: "feat: add A", body: "Adds module A." },
					{ subject: "fix: fix B", body: "Fixes bug in B." },
				);
				const output = yield* runWithLogAndFilesEffect(log, "src/a.ts\nsrc/b.ts\n");
				expect(output).toContain("Adds module A.");
				expect(output).toContain("Fixes bug in B.");
				expect(output).toContain("## Description");
			}),
		));

	test("--description-file overrides computed description", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("fill-pr-template-");
				return yield* Effect.gen(function* () {
					const log = logContent({ subject: "feat: add x", body: "Original body" });
					yield* tmp.writeFile(tmp.join("commits.txt"), log);
					yield* tmp.writeFile(tmp.join("files.txt"), "src/foo.ts\n");
					yield* tmp.writeFile(tmp.join("template.md"), TEST_TEMPLATE);
					yield* tmp.writeFile(tmp.join("description.txt"), "Ollama-generated summary.");
					const output = yield* runFillBody(
						tmp.join("commits.txt"),
						tmp.join("files.txt"),
						tmp.join("template.md"),
						"body",
						tmp.join("description.txt"),
					);
					expect(output).toContain("Ollama-generated summary.");
					expect(output).not.toContain("Original body");
					return output;
				}).pipe(Effect.ensuring(tmp.remove()));
			}).pipe(Effect.scoped),
		));

	test("filters merge commits, includes non-conventional", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent(
					{ subject: "feat: add foo", body: "" },
					{ subject: "Merge branch 'main' into ai/merge-test", body: "" },
					{ subject: "wip: messy commit", body: "" },
					{ subject: "feat: add y", body: "" },
				);
				const output = yield* runWithLogAndFilesEffect(log, "src/foo.ts\nsrc/y.ts\n", {
					format: "title-body",
				});
				expect(output).toContain("feat: add foo");
				expect(output).toContain("wip: messy commit");
				expect(output).toContain("feat: add y");
				expect(output).not.toContain("Merge branch");
			}),
		));

	test("extracts Closes #42, docs-only → type Documentation update", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const log = logContent({ subject: "docs: update guide", body: "Closes #42" });
				const output = yield* runWithLogAndFilesEffect(log, "docs/guide.md\n");
				expect(output).toContain("Closes #42");
				expect(output).toContain("Documentation update");
				expect(output).toContain("npm run check");
			}),
		));

	test("uses custom template when path provided", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("fill-pr-template-");
				return yield* Effect.gen(function* () {
					yield* tmp.writeFile(
						tmp.join("custom.md"),
						"Custom: {{description}}\nType: {{typeOfChange}}\n{{changes}}",
					);
					const log = logContent({ subject: "feat: add bar", body: "Bar feature here." });
					yield* tmp.writeFile(tmp.join("commits.txt"), log);
					yield* tmp.writeFile(tmp.join("files.txt"), "src/bar.ts\n");
					const output = yield* runFillBody(
						tmp.join("commits.txt"),
						tmp.join("files.txt"),
						tmp.join("custom.md"),
						"body",
					);
					expect(output).toContain("Custom: Bar feature here.");
					expect(output).toContain("Type: New feature");
					expect(output).toContain("feat: add bar");
					return output;
				}).pipe(Effect.ensuring(tmp.remove()));
			}).pipe(Effect.scoped),
		));

	test("fails when log file not found", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("fill-pr-template-");
				return yield* Effect.gen(function* () {
					yield* tmp.writeFile(tmp.join("template.md"), TEST_TEMPLATE);
					yield* tmp.writeFile(tmp.join("files.txt"), "src/foo.ts\n");
					const err = yield* runFillBody(
						tmp.join("nonexistent.txt"),
						tmp.join("files.txt"),
						tmp.join("template.md"),
						"body",
					).pipe(Effect.flip);
					const msg = err instanceof Error ? err.message : String(err);
					expect(
						msg.includes("Log file not found") ||
							msg.includes("nonexistent") ||
							msg.includes("File system error"),
					).toBe(true);
					return err;
				}).pipe(Effect.ensuring(tmp.remove()));
			}).pipe(Effect.scoped),
		));

	test("fails when no commits (empty title in title-body format)", async () =>
		runEffect(RunFillBodyTestLayer)(
			Effect.gen(function* () {
				const err = yield* runWithLogAndFilesEffect("", "", { format: "title-body" }).pipe(
					Effect.flip,
				);
				const msg = err instanceof Error ? err.message : String(err);
				expect(msg).toContain("PR title is empty");
			}),
		));
});

// ─── handleValidateTitle / handleOutputDescriptionPrompt ─────────────────────

const HandleValidateTitleLayer = Layer.mergeAll(TestBaseLayer);

describe("handleValidateTitle", () => {
	test("succeeds for valid conventional title", async () =>
		runEffect(HandleValidateTitleLayer)(handleValidateTitle("feat: add x")));
	test("succeeds for valid scoped title", async () =>
		runEffect(HandleValidateTitleLayer)(handleValidateTitle("fix(ci): resolve bug")));
	test("fails for invalid title", async () =>
		runEffect(HandleValidateTitleLayer)(
			Effect.gen(function* () {
				const err = yield* handleValidateTitle("not conventional").pipe(Effect.flip);
				expect(err).toBeInstanceOf(Error);
				expect((err as Error).message).toBe("Invalid conventional commit title");
			}),
		));
});

describe("handleOutputDescriptionPrompt", () => {
	test("outputs description prompt from log file", async () =>
		runEffect(TestBaseLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("fill-pr-output-prompt-");
				const log = logContent(
					{ subject: "feat: add foo", body: "Feature body here." },
					{ subject: "fix: fix bar", body: "Fix body." },
				);
				yield* tmp.writeFile(tmp.join("commits.txt"), log);
				yield* handleOutputDescriptionPrompt(tmp.join("commits.txt"), true).pipe(
					Effect.provide(TestBaseLayer),
				);
				return yield* tmp.remove();
			}).pipe(Effect.scoped),
		));
});

function runCliWithArgs(args: string[]): Effect.Effect<void, unknown, never> {
	return Command.runWith(fillCommand, { version: pkg.version })(args).pipe(
		Effect.provide(CliLayer),
	);
}

describe("fill-pr-template CLI", () => {
	const runCli = (args: string[]) => runCliWithArgs(args).pipe(Effect.exit);

	test("--validate-title valid exits 0", async () => {
		const exit = await Effect.runPromise(runCli(["--validate-title", "feat: add x"]));
		expect(Exit.isSuccess(exit)).toBe(true);
	});

	test("--validate-title invalid exits 1", async () => {
		const exit = await Effect.runPromise(runCli(["--validate-title", "invalid title"]));
		expect(Exit.isFailure(exit)).toBe(true);
		const msg = Exit.match(exit, {
			onSuccess: () => "",
			onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
		});
		expect(msg instanceof Error ? msg.message : msg).toContain("Invalid conventional commit title");
	});

	test("--output-description-prompt without --log-file exits 1", async () => {
		const exit = await Effect.runPromise(runCli(["--output-description-prompt"]));
		expect(Exit.isFailure(exit)).toBe(true);
		const msg = Exit.match(exit, {
			onSuccess: () => "",
			onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
		});
		expect(msg instanceof Error ? msg.message : msg).toContain("--log-file");
	});

	test("--format required when filling", async () => {
		const exit = await Effect.runPromise(
			runCli(["--log-file", "/tmp/x", "--files-file", "/tmp/y", "--template", "/tmp/z"]),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const msg = Exit.match(exit, {
			onSuccess: () => "",
			onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
		});
		expect(msg instanceof Error ? msg.message : msg).toContain("--format");
	});

	test("--format invalid value exits 1", async () => {
		const exit = await Effect.runPromise(
			runCli([
				"--log-file",
				"/tmp/x",
				"--files-file",
				"/tmp/y",
				"--template",
				"/tmp/z",
				"--format",
				"invalid",
			]),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const msg = Exit.match(exit, {
			onSuccess: () => "",
			onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
		});
		expect(msg instanceof Error ? msg.message : msg).toContain("body");
		expect(msg instanceof Error ? msg.message : msg).toContain("title-body");
	});

	test("--template required when filling", async () => {
		const exit = await Effect.runPromise(
			runCli(["--log-file", "/tmp/x", "--files-file", "/tmp/y", "--format", "body"]),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const msg = Exit.match(exit, {
			onSuccess: () => "",
			onFailure: (cause) => Option.getOrElse(Cause.findErrorOption(cause), () => String(cause)),
		});
		expect(msg instanceof Error ? msg.message : msg).toContain("--template");
	});
});
