import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Layer, Redacted, Result } from "effect";
import {
	aiProviderLayerFromConfig,
	DiffToolkit,
	NoSemanticCommitsError,
	ParseError,
	TemplateRenderError,
} from "#auto-pr";
import { GitContext } from "#auto-pr/git-context.js";
import { FillPrTemplateValidationError } from "#core/errors.js";
import { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";
import { runEffect } from "#test/run-effect.js";
import {
	createGitContextMock,
	createOpenAiChatCompletionsMockFetch,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import type { GeneratePrContentParams } from "#workflow/auto-pr-generate-content.js";
import {
	generatePrContent,
	normalizeUnknownToGeneratePrContentError,
} from "#workflow/auto-pr-generate-content.js";

function logContent(...blocks: Array<{ hash?: string; subject: string; body: string }>): string {
	const formatted = blocks.map((b) => {
		const hash = b.hash ?? "0000000000000000000000000000000000000000";
		const msg = b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject;
		return `${hash}\n${msg}`;
	});
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const DEFAULT_TEMPLATE = "# PR\n\n{{description}}";
const TEMPLATE_WITH_CHANGES = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";
const DEFAULT_DESCRIPTION_PROMPT =
	"Summarize these commits. Return JSON with title and description.";

function mockGitContext(
	commits: Array<{ hash?: string; subject: string; body: string }>,
	files = "src/foo.ts\n",
	diffStat = " src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)",
): GitContext {
	return createGitContextMock({
		getLog: () => Effect.succeed(logContent(...commits)),
		getChangedFiles: () => Effect.succeed(files),
		getDiffStat: () => Effect.succeed(diffStat),
		getDiff: () => Effect.succeed(""),
		getCommitDiff: () => Effect.succeed(""),
	});
}

function makeParams(
	commits: Array<{ hash?: string; subject: string; body: string }>,
	overrides?: Partial<GeneratePrContentParams> & {
		files?: string;
		diffStat?: string;
		fetch?: typeof fetch;
	},
): { params: GeneratePrContentParams; gitCtx: GitContext; fetch: typeof fetch | undefined } {
	return {
		params: {
			baseRef: "origin/main",
			headRef: "ai/test",
			templateContent: DEFAULT_TEMPLATE,
			descriptionPromptText: DEFAULT_DESCRIPTION_PROMPT,
			provider: "local" as const,
			model: "gpt-oss",
			retryDelay: Duration.zero,
			...overrides,
		},
		gitCtx: mockGitContext(commits, overrides?.files, overrides?.diffStat),
		fetch: overrides?.fetch,
	};
}

const ValueBasedLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

/** Mock DiffToolkit handler layer — tools return empty strings (never called by mock AI). */
const MockDiffToolkitLayer = DiffToolkit.toLayer(
	Effect.succeed(
		DiffToolkit.of({
			get_diff: () => Effect.succeed(""),
			get_commit_diff: () => Effect.succeed(""),
		}),
	),
);

function layerForTest(p: {
	params: GeneratePrContentParams;
	gitCtx: GitContext;
	fetch: typeof fetch | undefined;
}) {
	return Layer.mergeAll(
		ValueBasedLayer,
		Layer.succeed(GitContext, p.gitCtx),
		MockDiffToolkitLayer,
		aiProviderLayerFromConfig(
			{
				provider: p.params.provider,
				model: p.params.model,
				...(p.params.provider === "github-models"
					? { ghToken: Redacted.make("mock-github-token") }
					: {}),
			},
			p.fetch !== undefined ? { fetch: p.fetch } : undefined,
		),
	);
}

describe("generatePrContent (GitContext-based, no file I/O)", () => {
	test("returns title and body for 1 commit (no AI call)", async () => {
		const p = makeParams([{ subject: "feat: add x", body: "" }]);
		await runEffect(layerForTest(p))(
			Effect.gen(function* () {
				const result = yield* generatePrContent(p.params);
				expect(result.title).toBe("feat: add x");
				expect(result.body).toContain("add x");
				expect(result.count).toBe(1);
			}).pipe(Effect.scoped),
		);
	});

	test("fails with NoSemanticCommitsError when all commits are merge", async () => {
		const p = makeParams([
			{ subject: "Merge branch 'main' into feature", body: "" },
			{ subject: "Merge pull request #1", body: "" },
		]);
		await runEffect(layerForTest(p))(
			Effect.gen(function* () {
				const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
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
		const p = makeParams([{ subject: "feat: add x", body: "" }], {
			templateContent: "# PR\n\n{{description",
		});
		await runEffect(layerForTest(p))(
			Effect.gen(function* () {
				const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
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

describe("generatePrContent (2+ commits, mocked OpenAI-compat)", () => {
	describe("valid title", () => {
		test("returns AI title and body with structured description sections (local provider)", async () => {
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.body).toContain(
						"- Align CI and provider behavior so multi-commit PR generation is easier to review and operate.",
					);
				}).pipe(Effect.scoped),
			);
		});

		test("renders benefits as bullet points", async () => {
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.body).toContain(
						"- Reviewers can now validate CI changes in a single consistent place.",
					);
				}).pipe(Effect.scoped),
			);
		});

		test("includes ### Benefits between ### Motivation and ### Risks", async () => {
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(responseEmptyBenefits),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.body).not.toContain("### Benefits");
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
				}).pipe(Effect.scoped),
			);
		});

		test("same generateText + JSON path for github-models provider (mocked)", async () => {
			const p = makeParams(twoCommits, {
				provider: "github-models",
				model: "microsoft/phi-mock",
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(longResponse),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOpenAiChatCompletionsMockFetch(longResponse),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add X and fix B");
					expect(result.body).toContain(longBullet.slice(0, 80));
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("invalid title (fallback)", () => {
		test("falls back to first commit subject when local LLM returns invalid title 5 times", async () => {
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(INVALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add module A");
					expect(result.body).toContain("### Motivation");
					expect(result.body).toContain("### Risks");
					expect(result.count).toBe(2);
				}).pipe(Effect.scoped),
			);
		});

		test("falls back to chore: update when first commit subject is non-conventional", async () => {
			const p = makeParams(
				[
					{ subject: "Add feature", body: "" },
					{ subject: "Fix bug", body: "" },
				],
				{
					retryDelay: Duration.zero,
					fetch: createOpenAiChatCompletionsMockFetch(INVALID_AI_RESPONSE),
				},
			);
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(bad),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(bad),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("empty assistant content", () => {
		test("falls back when local LLM returns empty content 5 times", async () => {
			const p = makeParams(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch(""),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("invalid JSON in assistant content", () => {
		test("falls back when local LLM returns invalid JSON 5 times", async () => {
			const p = makeParams(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch("feat: x\n\n"),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
			);
		});
	});

	describe("HTTP 500 from OpenAI-compat endpoint", () => {
		test("falls back when local endpoint returns HTTP 500 five times", async () => {
			const p = makeParams(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch({
					content: VALID_AI_RESPONSE,
					status: 500,
				}),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
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
