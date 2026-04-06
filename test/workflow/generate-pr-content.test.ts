import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, FileSystem, Layer, Path, Redacted, Result } from "effect";
import {
	aiProviderLayerFromConfig,
	NoSemanticCommitsError,
	ParseError,
	TemplateRenderError,
	UnexpectedError,
} from "#auto-pr";
import { FillPrTemplateValidationError } from "#core/errors.js";
import { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";
import { runEffect } from "#test/run-effect.js";
import {
	createOpenAiChatCompletionsMockFetch,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import type { GeneratePrContentFromValuesParams } from "#workflow/auto-pr-generate-content.js";
import {
	generatePrContentFromValues,
	normalizeUnknownToGeneratePrContentError,
	runGeneratePrContent,
} from "#workflow/auto-pr-generate-content.js";

function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const DEFAULT_TEMPLATE = "# PR\n\n{{description}}";
const TEMPLATE_WITH_CHANGES = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";
const DEFAULT_DESCRIPTION_PROMPT =
	"Summarize these commits. Return JSON with title and description.";

function params(
	commits: Array<{ subject: string; body: string }>,
	overrides?: Partial<GeneratePrContentFromValuesParams>,
): GeneratePrContentFromValuesParams {
	return {
		commitsContent: logContent(...commits),
		filesContent: "src/foo.ts\n",
		templateContent: DEFAULT_TEMPLATE,
		descriptionPromptText: DEFAULT_DESCRIPTION_PROMPT,
		provider: "local" as const,
		model: "gpt-oss",
		...overrides,
	};
}

const ValueBasedLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

function layerForGeneratePrContent(params: GeneratePrContentFromValuesParams) {
	return Layer.mergeAll(
		ValueBasedLayer,
		aiProviderLayerFromConfig(
			{
				provider: params.provider,
				model: params.model,
				...(params.provider === "github-models"
					? { ghToken: Redacted.make("mock-github-token") }
					: {}),
			},
			params.fetch !== undefined ? { fetch: params.fetch } : undefined,
		),
	);
}

describe("generatePrContentFromValues (value-based, no file I/O)", () => {
	test("returns title and body for 1 commit (no local LLM call)", async () => {
		const p = params([{ subject: "feat: add x", body: "" }]);
		await runEffect(layerForGeneratePrContent(p))(
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(p);
				expect(result.title).toBe("feat: add x");
				expect(result.body).toContain("add x");
				expect(result.count).toBe(1);
			}).pipe(Effect.scoped),
		);
	});

	test("fails with NoSemanticCommitsError when all commits are merge", async () => {
		const p = params([
			{ subject: "Merge branch 'main' into feature", body: "" },
			{ subject: "Merge pull request #1", body: "" },
		]);
		await runEffect(layerForGeneratePrContent(p))(
			Effect.gen(function* () {
				const exit = yield* generatePrContentFromValues(p).pipe(Effect.exit, Effect.scoped);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					Result.match(Cause.findError(exit.cause), {
						onSuccess: (err) => expect(err).toBeInstanceOf(NoSemanticCommitsError),
						onFailure: () => expect().fail("expected Fail cause"),
					});
				}
			}).pipe(Effect.scoped),
		);
	});

	test("fails with TemplateRenderError when template is malformed", async () => {
		const p = params([{ subject: "feat: add x", body: "" }], {
			templateContent: "# PR\n\n{{description",
		});
		await runEffect(layerForGeneratePrContent(p))(
			Effect.gen(function* () {
				const exit = yield* generatePrContentFromValues(p).pipe(Effect.exit, Effect.scoped);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					Result.match(Cause.findError(exit.cause), {
						onSuccess: (err) => expect(err).toBeInstanceOf(TemplateRenderError),
						onFailure: () => expect().fail("expected Fail cause"),
					});
				}
			}).pipe(Effect.scoped),
		);
	});
});

describe("normalizeUnknownToGeneratePrContentError", () => {
	test("returns decoded error when plain object matches schema", () => {
		const plain = {
			_tag: "NoSemanticCommitsError" as const,
			message: "no semantic commits",
		};
		const result = normalizeUnknownToGeneratePrContentError(plain);
		expect(result._tag).toBe("NoSemanticCommitsError");
		expect((result as { message: string }).message).toBe("no semantic commits");
	});

	test("returns TemplateRenderError when input is generic Error", () => {
		const err = new Error("raw error");
		const result = normalizeUnknownToGeneratePrContentError(err);
		expect(result).toBeInstanceOf(TemplateRenderError);
		expect((result as TemplateRenderError).message).toBe("Unexpected failure");
		expect((result as TemplateRenderError).cause).toBe(err);
	});

	test("returns TemplateRenderError when input is non-Error (string)", () => {
		const result = normalizeUnknownToGeneratePrContentError("oops");
		expect(result).toBeInstanceOf(TemplateRenderError);
		expect((result as TemplateRenderError).cause).toBeInstanceOf(Error);
		expect(((result as TemplateRenderError).cause as Error).message).toBe("oops");
	});

	test("decodes class instances via Schema (ParseError)", () => {
		const parseErr = new ParseError({ message: "bad" });
		const result = normalizeUnknownToGeneratePrContentError(parseErr);
		expect(result._tag).toBe("ParseError");
		expect((result as ParseError).message).toBe("bad");
	});

	test("wraps FillPrTemplateValidationError as TemplateRenderError (not in generate schema)", () => {
		const err = new FillPrTemplateValidationError({ message: "invalid" });
		const result = normalizeUnknownToGeneratePrContentError(err);
		expect(result).toBeInstanceOf(TemplateRenderError);
	});
});

const VALID_AI_RESPONSE = JSON.stringify({
	title: "feat: add X and fix B",
	motivation: [
		"Align CI and provider behavior so multi-commit PR generation is easier to review and operate.",
	],
	benefits: ["Reviewers can now validate CI changes in a single consistent place."],
	risks: [
		"Verify token handling and workflow permissions in reusable GitHub Actions jobs.",
		"Double-check provider integration paths when switching between local and remote models.",
	],
	notesForReviewers:
		"Start with `src/workflow/auto-pr-generate-content.ts` and related prompt changes.",
});
const INVALID_AI_RESPONSE = '{"title":"feat","description":"Invalid."}';

const twoCommits = [
	{ subject: "feat: add module A", body: "Adds A." },
	{ subject: "fix: fix bug in B", body: "Fixes B." },
];

describe("generatePrContentFromValues (2+ commits, mocked OpenAI-compat)", () => {
	describe("valid title", () => {
		test("returns AI title and body with structured description sections (local provider)", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add X and fix B");
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain(
						"Align CI and provider behavior so multi-commit PR generation is easier to review and operate.",
					);
					expect(result.body).toContain("### Risks");
					expect(result.body).toContain(
						"- Verify token handling and workflow permissions in reusable GitHub Actions jobs.",
					);
					expect(result.body).toContain("### Notes for reviewers");
					expect(result.body).toContain(
						"Start with `src/workflow/auto-pr-generate-content.ts` and related prompt changes.",
					);
					expect(result.body).toContain("feat: add module A");
					expect(result.body).toContain("fix: fix bug in B");
					expect(result.count).toBe(2);
				}).pipe(Effect.scoped),
			);
		});

		test("renders motivation as bullet points", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.body).toContain(
						"- Align CI and provider behavior so multi-commit PR generation is easier to review and operate.",
					);
				}).pipe(Effect.scoped),
			);
		});

		test("renders benefits as bullet points", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.body).toContain(
						"- Reviewers can now validate CI changes in a single consistent place.",
					);
				}).pipe(Effect.scoped),
			);
		});

		test("includes ### Benefits between ### Motivation and ### Risks", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.body).toContain("### Benefits");
					expect(result.body).toContain(
						"Reviewers can now validate CI changes in a single consistent place.",
					);
					const motivationIdx = result.body.indexOf("### Motivation");
					const benefitsIdx = result.body.indexOf("### Benefits");
					const risksIdx = result.body.indexOf("### Risks");
					expect(motivationIdx).toBeLessThan(benefitsIdx);
					expect(benefitsIdx).toBeLessThan(risksIdx);
				}).pipe(Effect.scoped),
			);
		});

		test("omits ### Benefits section when benefits is empty array", async () => {
			const responseEmptyBenefits = JSON.stringify({
				title: "feat: add X and fix B",
				motivation: ["Motivation here."],
				benefits: [],
				risks: ["One risk."],
				notesForReviewers: "",
			});
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(responseEmptyBenefits),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.body).not.toContain("### Benefits");
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
				}).pipe(Effect.scoped),
			);
		});

		test("same generateText + JSON path for github-models provider (mocked)", async () => {
			const p = params(twoCommits, {
				provider: "github-models",
				model: "microsoft/phi-mock",
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add X and fix B");
					expect(result.body).toContain("### Motivation");
				}).pipe(Effect.scoped),
			);
		});

		test("accepts long conventional title by shortening subject to max length (no fallback)", async () => {
			const longTitle = `feat(generate-content): structured AI-driven PR metadata with enhanced CI and validation${"x".repeat(25)}`;
			expect(longTitle.length).toBeGreaterThan(PR_TITLE_LINE_MAX_LENGTH);
			const longResponse = JSON.stringify({
				title: longTitle,
				motivation: ["Short motivation for the change."],
				benefits: [],
				risks: ["One risk bullet."],
				notesForReviewers: "",
			});
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(longResponse),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title.length).toBe(PR_TITLE_LINE_MAX_LENGTH);
					expect(result.title.startsWith("feat(generate-content): ")).toBe(true);
					expect(result.body).toContain("### Motivation");
				}).pipe(Effect.scoped),
			);
		});

		test("handles very long bullet in model_response logging path", async () => {
			const longBullet = `MOTIVATION_${"x".repeat(2100)}`;
			const longResponse = JSON.stringify({
				title: "feat: add X and fix B",
				motivation: ["Short first bullet.", longBullet],
				benefits: [],
				risks: ["Short risk only."],
				notesForReviewers: "n",
			});
			const p = params(twoCommits, {
				filesContent: "src/a.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(longResponse),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add X and fix B");
					expect(result.body).toContain(longBullet.slice(0, 80));
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("invalid title (fallback)", () => {
		test("falls back to first commit subject when local LLM returns invalid title 5 times", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(INVALID_AI_RESPONSE),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
					expect(result.count).toBe(2);
				}).pipe(Effect.scoped),
			);
		});

		test("falls back to chore: update when first commit subject is non-conventional", async () => {
			const p = params(
				[
					{ subject: "Add feature", body: "" },
					{ subject: "Fix bug", body: "" },
				],
				{
					retryDelay: Duration.zero,
					fetch: createOpenAiChatCompletionsMockFetch(INVALID_AI_RESPONSE),
				},
			);
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("chore: update");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("invalid structured fields (validation retries then fallback)", () => {
		test("falls back when motivation is empty array after 5 attempts", async () => {
			const bad = JSON.stringify({
				title: "feat: valid title",
				motivation: [],
				benefits: [],
				risks: ["Risk one."],
				notesForReviewers: "",
			});
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(bad),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});

		test("falls back when risks normalize to empty after 5 attempts", async () => {
			const bad = JSON.stringify({
				title: "feat: valid title",
				motivation: ["Has motivation."],
				benefits: [],
				risks: ["", "  ", "-  "],
				notesForReviewers: "",
			});
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(bad),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("empty assistant content", () => {
		test("falls back when local LLM returns empty content 5 times", async () => {
			const p = params(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(""),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("invalid JSON in assistant content", () => {
		test("falls back when local LLM returns invalid JSON 5 times", async () => {
			const p = params(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch("feat: x\n\n"),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("HTTP 500 from OpenAI-compat endpoint", () => {
		test("falls back when local endpoint returns HTTP 500 five times", async () => {
			const p = params(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch({
					content: VALID_AI_RESPONSE,
					status: 500,
				}),
			});
			await runEffect(layerForGeneratePrContent(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});
});

describe("catchDefect (defect → TemplateRenderError)", () => {
	test("converts defect to TemplateRenderError when sync throws", async () => {
		const defectEffect = Effect.sync(() => {
			throw new Error("defect");
		}).pipe(Effect.catchDefect((d) => Effect.fail(normalizeUnknownToGeneratePrContentError(d))));
		const exit = await Effect.runPromise(defectEffect.pipe(Effect.exit));
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			Result.match(Cause.findError(exit.cause), {
				onSuccess: (err) => {
					expect(err).toBeInstanceOf(TemplateRenderError);
					expect((err as TemplateRenderError).message).toBe("Unexpected failure");
					expect((err as TemplateRenderError).cause).toBeInstanceOf(Error);
					expect(((err as TemplateRenderError).cause as Error).message).toBe("defect");
				},
				onFailure: () => expect().fail("expected Fail cause"),
			});
		}
	});
});

const RunIntegrationLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

describe("runGeneratePrContent (integration, file I/O)", () => {
	test("fails with UnexpectedError when commits file is missing", async () => {
		await runEffect(RunIntegrationLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("generate-pr-missing-commits-");
				const pathApi = yield* Path.Path;
				const missingCommits = pathApi.join(tmp.path, "does-not-exist-commits.txt");
				const filesPath = pathApi.join(tmp.path, "files.txt");
				const templatePath = pathApi.join(tmp.path, "template.md");
				const fs = yield* FileSystem.FileSystem;
				yield* fs.writeFileString(filesPath, "src/a.ts\n");
				yield* fs.writeFileString(templatePath, DEFAULT_TEMPLATE);

				const exit = yield* runGeneratePrContent({
					commits: missingCommits,
					files: filesPath,
					workspace: tmp.path,
					templatePath,
					provider: "local",
					model: "gpt-oss",
					fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
				}).pipe(Effect.exit);

				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					Result.match(Cause.findError(exit.cause), {
						onSuccess: (err) => {
							expect(err).toBeInstanceOf(UnexpectedError);
							expect((err as UnexpectedError).cause).toContain("commits");
						},
						onFailure: () => expect().fail("expected UnexpectedError"),
					});
				}
			}).pipe(Effect.scoped),
		);
	});

	test("reads files, writes pr-title.txt and pr-body.md (github-models + ghToken)", async () => {
		await runEffect(RunIntegrationLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("generate-pr-content-github-models-");
				const fs = yield* FileSystem.FileSystem;
				const pathApi = yield* Path.Path;

				const commitsPath = pathApi.join(tmp.path, "commits.txt");
				const filesPath = pathApi.join(tmp.path, "files.txt");
				const templatePath = pathApi.join(tmp.path, "template.md");

				yield* fs.writeFileString(
					commitsPath,
					logContent(
						{ subject: "feat: add module A", body: "Adds A." },
						{ subject: "fix: fix bug in B", body: "Fixes B." },
					),
				);
				yield* fs.writeFileString(filesPath, "src/a.ts\nsrc/b.ts\n");
				yield* fs.writeFileString(templatePath, TEMPLATE_WITH_CHANGES);

				yield* runGeneratePrContent({
					commits: commitsPath,
					files: filesPath,
					workspace: tmp.path,
					templatePath,
					provider: "github-models",
					model: "openai/gpt-4.1-mini",
					ghToken: Redacted.make("ghp_integration_test"),
					retryDelay: Duration.zero,
					fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
				});

				const titlePath = pathApi.join(tmp.path, "pr-title.txt");
				const titleContent = yield* fs.readFileString(titlePath);
				expect(titleContent).toContain("feat: add X and fix B");
			}).pipe(Effect.scoped),
		);
	});

	test("reads files, writes pr-title.txt and pr-body.md", async () => {
		await runEffect(RunIntegrationLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("generate-pr-content-integration-");
				const fs = yield* FileSystem.FileSystem;
				const pathApi = yield* Path.Path;

				const commitsPath = pathApi.join(tmp.path, "commits.txt");
				const filesPath = pathApi.join(tmp.path, "files.txt");
				const templatePath = pathApi.join(tmp.path, "template.md");

				yield* fs.writeFileString(commitsPath, logContent({ subject: "feat: add x", body: "" }));
				yield* fs.writeFileString(filesPath, "src/foo.ts\n");
				yield* fs.writeFileString(templatePath, DEFAULT_TEMPLATE);

				yield* runGeneratePrContent({
					commits: commitsPath,
					files: filesPath,
					workspace: tmp.path,
					templatePath,
					provider: "local",
					model: "gpt-oss",
					fetch: createOpenAiChatCompletionsMockFetch(""),
				});

				const titlePath = pathApi.join(tmp.path, "pr-title.txt");
				const titleContent = yield* fs.readFileString(titlePath);
				expect(titleContent).toContain("feat: add x");

				const bodyPath = pathApi.join(tmp.path, "pr-body.md");
				const bodyContent = yield* fs.readFileString(bodyPath);
				expect(bodyContent).toContain("add x");
			}).pipe(Effect.scoped),
		);
	});
});
