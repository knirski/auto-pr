import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Result } from "effect";
import { NoSemanticCommitsError } from "#auto-pr";
import {
	createTestTempDirEffect,
	OllamaHttpClientMock,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import type { GeneratePrContentFromValuesParams } from "#workflow/generate-pr-content.js";
import {
	generatePrContentFromValues,
	runGeneratePrContent,
} from "#workflow/generate-pr-content.js";

/** Format commit blocks for parseCommits (---COMMIT--- separated). */
function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const DEFAULT_TEMPLATE = "# PR\n\n{{description}}";
const TEMPLATE_WITH_CHANGES = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";
const DEFAULT_HOW_TO_TEST = "1. Run `npm run check`\n2. ";
const DEFAULT_DESCRIPTION_PROMPT = "Summarize. Line 1: title. Line 2: blank. Line 3+: description.";

function params(
	commits: Array<{ subject: string; body: string }>,
	overrides?: Partial<GeneratePrContentFromValuesParams>,
): GeneratePrContentFromValuesParams {
	return {
		commitsContent: logContent(...commits),
		filesContent: "src/foo.ts\n",
		templateContent: DEFAULT_TEMPLATE,
		descriptionPromptText: DEFAULT_DESCRIPTION_PROMPT,
		howToTestDefault: DEFAULT_HOW_TO_TEST,
		model: "llama3.1:8b",
		ollamaUrl: "http://localhost:11434/api/generate",
		...overrides,
	};
}

const ValueBasedLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	OllamaHttpClientMock(""), // unused for 1-commit
);

layer(ValueBasedLayer)("generatePrContentFromValues (value-based, no file I/O)", (it) => {
	it.effect("returns title and body for 1 commit (no Ollama)", () =>
		Effect.gen(function* () {
			const result = yield* generatePrContentFromValues(
				params([{ subject: "feat: add x", body: "" }]),
			);
			expect(result.title).toBe("feat: add x");
			expect(result.body).toContain("add x"); // description from subject
			expect(result.count).toBe(1);
		}).pipe(Effect.scoped),
	);

	it.effect("fails with NoSemanticCommitsError when all commits are merge", () =>
		Effect.gen(function* () {
			const exit = yield* generatePrContentFromValues(
				params([
					{ subject: "Merge branch 'main' into feature", body: "" },
					{ subject: "Merge pull request #1", body: "" },
				]),
			).pipe(Effect.exit, Effect.scoped);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				Result.match(Cause.findError(exit.cause), {
					onSuccess: (err) => expect(err).toBeInstanceOf(NoSemanticCommitsError),
					onFailure: () => expect.fail("expected Fail cause"),
				});
			}
		}).pipe(Effect.scoped),
	);
});

const VALID_OLLAMA_RESPONSE = "feat: add X and fix B\n\nOllama-generated summary.";
const INVALID_OLLAMA_RESPONSE = "feat\n\nInvalid.";

const twoCommits = [
	{ subject: "feat: add module A", body: "Adds A." },
	{ subject: "fix: fix bug in B", body: "Fixes B." },
];

layer(ValueBasedLayer)("generatePrContentFromValues (2+ commits, mocked Ollama)", (it) => {
	it.layer(OllamaHttpClientMock(VALID_OLLAMA_RESPONSE))("valid title", (it) => {
		it.effect("returns Ollama title and body with description", () =>
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(
					params(twoCommits, {
						filesContent: "src/a.ts\nsrc/b.ts\n",
						templateContent: TEMPLATE_WITH_CHANGES,
					}),
				);
				expect(result.title).toBe("feat: add X and fix B");
				expect(result.body).toContain("Ollama-generated summary.");
				expect(result.body).toContain("feat: add module A");
				expect(result.body).toContain("fix: fix bug in B");
				expect(result.count).toBe(2);
			}).pipe(Effect.scoped),
		);
	});

	it.layer(OllamaHttpClientMock(INVALID_OLLAMA_RESPONSE))("invalid title (fallback)", (it) => {
		it.effect("falls back to first commit subject when Ollama returns invalid title 5 times", () =>
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(
					params(twoCommits, {
						filesContent: "src/a.ts\nsrc/b.ts\n",
						templateContent: TEMPLATE_WITH_CHANGES,
						retryDelayMs: 0,
					}),
				);
				expect(result.title).toBe("feat: add module A");
				expect(result.count).toBe(2);
			}).pipe(Effect.scoped),
		);

		it.effect("falls back to chore: update when first commit subject is non-conventional", () =>
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(
					params(
						[
							{ subject: "Add feature", body: "" },
							{ subject: "Fix bug", body: "" },
						],
						{ retryDelayMs: 0 },
					),
				);
				expect(result.title).toBe("chore: update");
			}).pipe(Effect.scoped),
		);
	});

	it.layer(OllamaHttpClientMock(""))("Ollama empty response", (it) => {
		it.effect("falls back when Ollama returns empty response 5 times", () =>
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(params(twoCommits, { retryDelayMs: 0 }));
				expect(result.title).toBe("feat: add module A");
			}).pipe(Effect.scoped),
		);
	});

	it.layer(OllamaHttpClientMock("feat: x\n\n"))("Ollama title-only (no description)", (it) => {
		it.effect("falls back when Ollama returns title-only 5 times", () =>
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(params(twoCommits, { retryDelayMs: 0 }));
				expect(result.title).toBe("feat: add module A");
			}).pipe(Effect.scoped),
		);
	});

	it.layer(OllamaHttpClientMock({ response: VALID_OLLAMA_RESPONSE, status: 500 }))(
		"Ollama HTTP 500",
		(it) => {
			it.effect("falls back when Ollama returns HTTP 500 five times", () =>
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(
						params(twoCommits, { retryDelayMs: 0 }),
					);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		},
	);
});

/** Integration: runGeneratePrContent with file I/O. Verifies shell reads files, writes outputs. */
const RunIntegrationLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	OllamaHttpClientMock(""), // unused for 1-commit
);

layer(RunIntegrationLayer)("runGeneratePrContent (integration, file I/O)", (it) => {
	it.effect("reads files, writes title and body_file to GITHUB_OUTPUT and pr-body.md", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("generate-pr-content-integration-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			const commitsPath = pathApi.join(tmp.path, "commits.txt");
			const filesPath = pathApi.join(tmp.path, "files.txt");
			const ghOutput = pathApi.join(tmp.path, "github_output.txt");
			const templatePath = pathApi.join(tmp.path, "template.md");

			yield* fs.writeFileString(commitsPath, logContent({ subject: "feat: add x", body: "" }));
			yield* fs.writeFileString(filesPath, "src/foo.ts\n");
			yield* fs.writeFileString(templatePath, DEFAULT_TEMPLATE);

			yield* runGeneratePrContent({
				commits: commitsPath,
				files: filesPath,
				ghOutput,
				workspace: tmp.path,
				templatePath,
				model: "llama3.1:8b",
				ollamaUrl: "http://localhost:11434/api/generate",
				howToTestDefault: DEFAULT_HOW_TO_TEST,
			});

			const ghContent = yield* fs.readFileString(ghOutput);
			expect(ghContent).toContain("title=");
			expect(ghContent).toContain("body_file=");

			const bodyPath = pathApi.join(tmp.path, "pr-body.md");
			const bodyContent = yield* fs.readFileString(bodyPath);
			expect(bodyContent).toContain("add x");
		}).pipe(Effect.scoped),
	);
});
