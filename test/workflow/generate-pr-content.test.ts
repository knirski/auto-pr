import { describe, expect, test } from "bun:test";
import {
	Cause,
	ConfigProvider,
	Duration,
	Effect,
	Exit,
	FileSystem,
	Layer,
	Option,
	Redacted,
	Result,
} from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	AutoPrConfigError,
	aiProviderLayerFromConfig,
	ChildProcessSpawnerLayer,
	DiffToolkit,
	NoSemanticCommitsError,
	ParseError,
	PullRequestClient,
	TemplateRenderError,
} from "#auto-pr";
import { GitContext } from "#auto-pr/git-context.js";
import { FillPrTemplateValidationError, PullRequestLookupError } from "#core/errors.js";
import { PR_TITLE_LINE_MAX_LENGTH } from "#core/pr-title-line-max-length.js";
import { runEffect } from "#test/run-effect.js";
import {
	cleanGitEnv,
	createGitContextMock,
	createOpenAiChatCompletionsMockFetch,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import type { GeneratePrContentParams } from "#workflow/auto-pr-generate-content.js";
import {
	generatePrContent,
	normalizeUnknownToGeneratePrContentError,
	program,
	resolveExistingPrTitleForPrompt,
	runGeneratePrContent,
	runGeneratePrContentConfigFromGeneratePrContentConfig,
	runGeneratePrContentWithServices,
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
	const aiConfig =
		p.params.provider === "github-models"
			? {
					provider: "github-models" as const,
					model: p.params.model,
					ghToken: Redacted.make("mock-github-token"),
				}
			: {
					provider: "local" as const,
					model: p.params.model,
				};
	return Layer.mergeAll(
		ValueBasedLayer,
		Layer.succeed(GitContext, p.gitCtx),
		MockDiffToolkitLayer,
		aiProviderLayerFromConfig(aiConfig, p.fetch !== undefined ? { fetch: p.fetch } : undefined),
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
		expect((result as TemplateRenderError).cause).toBe("raw error");
	});

	test("returns TemplateRenderError when input is non-Error (string)", () => {
		const result = normalizeUnknownToGeneratePrContentError("oops");
		expect(result).toBeInstanceOf(TemplateRenderError);
		expect((result as TemplateRenderError).cause).toBe("oops");
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

	test("includes schema diagnostics for malformed tagged errors", () => {
		const result = normalizeUnknownToGeneratePrContentError({
			_tag: "ParseError",
			cause: "missing message",
		});
		expect(result).toBeInstanceOf(TemplateRenderError);
		expect(result.cause).toContain("ParseError did not match GeneratePrContentError");
		expect(result.cause).toContain("message");
	});
});

describe("runGeneratePrContentConfigFromGeneratePrContentConfig", () => {
	test("maps local config to runner config", () => {
		const apiKey = Redacted.make("sk-test", { label: "AUTO_PR_AI_OPENAI_COMPAT_API_KEY" });
		const config = runGeneratePrContentConfigFromGeneratePrContentConfig({
			provider: "local",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "gpt-oss",
			openaiCompatUrl: "http://127.0.0.1:8080/v1",
			openaiCompatApiKey: apiKey,
			existingPrTitle: "feat: existing title",
		});

		expect(config).toEqual({
			provider: "local",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "gpt-oss",
			openaiCompatUrl: "http://127.0.0.1:8080/v1",
			openaiCompatApiKey: apiKey,
			existingPrTitle: "feat: existing title",
		});
	});

	test("maps optional GitHub host settings to runner config", () => {
		const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
		const config = runGeneratePrContentConfigFromGeneratePrContentConfig({
			provider: "github-models",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "openai/gpt-4.1",
			ghToken,
			githubApiUrl: "https://api.github.com",
			ghHost: "github.com",
		});

		expect(config).toEqual({
			provider: "github-models",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "openai/gpt-4.1",
			ghToken,
			githubApiUrl: "https://api.github.com",
			ghHost: "github.com",
		});
	});

	test("maps github-models config to runner config", () => {
		const ghToken = Redacted.make("ghp_test", { label: "GH_TOKEN" });
		const config = runGeneratePrContentConfigFromGeneratePrContentConfig({
			provider: "github-models",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "openai/gpt-4.1",
			ghToken,
		});

		expect(config).toEqual({
			provider: "github-models",
			workspace: "/workspace",
			templatePath: "/workspace/.github/PULL_REQUEST_TEMPLATE.md",
			defaultBranch: "main",
			branch: "ai/example",
			model: "openai/gpt-4.1",
			ghToken,
		});
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

/** Asserts the OpenAI-style request body contains `mustContain` before returning `responseBody` as the model reply. */
function createOpenAiMockFetchExpectingPromptSubstring(
	mustContain: string,
	responseBody: string,
): typeof fetch {
	const inner = createOpenAiChatCompletionsMockFetch(responseBody);
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = init?.body;
		const bodyStr =
			typeof raw === "string"
				? raw
				: raw != null
					? await new Request("http://local.invalid", {
							method: "POST",
							body: raw as BodyInit,
						}).text()
					: "";
		expect(bodyStr).toContain(mustContain);
		return inner(input, init);
	}) as typeof fetch;
}

const twoCommits = [
	{ subject: "feat: add module A", body: "Adds A." },
	{ subject: "fix: fix bug in B", body: "Fixes B." },
];

describe("resolveExistingPrTitleForPrompt", () => {
	const layerWithPrClient = (
		findByBranch: () => Effect.Effect<
			Option.Option<{ readonly number: number; readonly url: string; readonly title?: string }>,
			PullRequestLookupError
		>,
	) =>
		Layer.mergeAll(
			TestBaseLayer,
			Layer.succeed(
				PullRequestClient,
				PullRequestClient.of({
					findByBranch,
					update: () => Effect.die(new Error("update should not be called")),
					create: () => Effect.die(new Error("create should not be called")),
				}),
			),
		);

	test("returns configured title when non-empty (does not call PR client)", async () => {
		await runEffect(
			layerWithPrClient(() => Effect.die(new Error("PR client should not run when config is set"))),
		)(
			Effect.gen(function* () {
				const opt = yield* resolveExistingPrTitleForPrompt({
					branch: "ai/x",
					existingPrTitle: "  feat: from config  ",
				});
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) expect(opt.value).toBe("feat: from config");
			}).pipe(Effect.scoped),
		);
	});

	test("returns title from PR client on success", async () => {
		await runEffect(
			layerWithPrClient(() =>
				Effect.succeed(
					Option.some({
						number: 1,
						url: "https://github.com/owner/repo/pull/1",
						title: "feat: from client",
					}),
				),
			),
		)(
			Effect.gen(function* () {
				const opt = yield* resolveExistingPrTitleForPrompt({
					branch: "ai/b",
				});
				expect(Option.isSome(opt)).toBe(true);
				if (Option.isSome(opt)) expect(opt.value).toBe("feat: from client");
			}).pipe(Effect.scoped),
		);
	});

	test("returns none when PR lookup fails", async () => {
		await runEffect(
			layerWithPrClient(() =>
				Effect.fail(new PullRequestLookupError({ branch: "ai/b", cause: "lookup failed" })),
			),
		)(
			Effect.gen(function* () {
				const opt = yield* resolveExistingPrTitleForPrompt({
					branch: "ai/b",
				});
				expect(Option.isNone(opt)).toBe(true);
			}).pipe(Effect.scoped),
		);
	});

	test("returns none when PR client returns no PR", async () => {
		await runEffect(layerWithPrClient(() => Effect.succeed(Option.none())))(
			Effect.gen(function* () {
				const opt = yield* resolveExistingPrTitleForPrompt({
					branch: "ai/b",
				});
				expect(Option.isNone(opt)).toBe(true);
			}).pipe(Effect.scoped),
		);
	});

	test("returns none when PR info has no title", async () => {
		await runEffect(
			layerWithPrClient(() =>
				Effect.succeed(
					Option.some({
						number: 1,
						url: "https://github.com/owner/repo/pull/1",
					}),
				),
			),
		)(
			Effect.gen(function* () {
				const opt = yield* resolveExistingPrTitleForPrompt({
					branch: "ai/b",
				});
				expect(Option.isNone(opt)).toBe(true);
			}).pipe(Effect.scoped),
		);
	});

	test("returns none when PR title is empty or whitespace-only after trim", async () => {
		for (const title of ["", "   \t  "]) {
			await runEffect(
				layerWithPrClient(() =>
					Effect.succeed(
						Option.some({
							number: 1,
							url: "https://github.com/owner/repo/pull/1",
							title,
						}),
					),
				),
			)(
				Effect.gen(function* () {
					const opt = yield* resolveExistingPrTitleForPrompt({
						branch: "ai/b",
					});
					expect(Option.isNone(opt)).toBe(true);
				}).pipe(Effect.scoped),
			);
		}
	});
});

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

		test("includes existingPrTitle in the AI request body for 2+ commits", async () => {
			const prior = "feat: existing open PR title";
			const p = makeParams(twoCommits, {
				files: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				existingPrTitle: prior,
				fetch: createOpenAiMockFetchExpectingPromptSubstring(prior, VALID_AI_RESPONSE),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const result = yield* generatePrContent(p.params);
					expect(result.title).toBe("feat: add X and fix B");
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

	describe("HTTP 401/403 from OpenAI-compat endpoint (auth failure)", () => {
		test("propagates as AutoPrConfigError when local endpoint returns HTTP 401", async () => {
			const p = makeParams(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch({
					content: VALID_AI_RESPONSE,
					status: 401,
				}),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
					expect(Exit.isFailure(exit)).toBe(true);
					if (Exit.isFailure(exit)) {
						Result.match(Cause.findError(exit.cause), {
							onSuccess: (err) => {
								expect(err).toBeInstanceOf(AutoPrConfigError);
								expect((err as AutoPrConfigError).missing.join(" ")).toContain(
									"AuthenticationError",
								);
							},
							onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
						});
					}
				}).pipe(Effect.scoped),
			);
		});

		test("propagates as AutoPrConfigError when local endpoint returns HTTP 403", async () => {
			const p = makeParams(twoCommits, {
				retryDelay: Duration.zero,
				fetch: createOpenAiChatCompletionsMockFetch({
					content: VALID_AI_RESPONSE,
					status: 403,
				}),
			});
			await runEffect(layerForTest(p))(
				Effect.gen(function* () {
					const exit = yield* generatePrContent(p.params).pipe(Effect.exit, Effect.scoped);
					expect(Exit.isFailure(exit)).toBe(true);
					if (Exit.isFailure(exit)) {
						Result.match(Cause.findError(exit.cause), {
							onSuccess: (err) => {
								expect(err).toBeInstanceOf(AutoPrConfigError);
								expect((err as AutoPrConfigError).missing.join(" ")).toContain(
									"AuthenticationError",
								);
							},
							onFailure: () => expect().fail("expected AutoPrConfigError in cause"),
						});
					}
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
					expect((err as TemplateRenderError).cause).toBe("defect");
				},
				onFailure: () => expect().fail("expected Fail cause"),
			});
		}
	});
});

// ─── runGeneratePrContent integration tests (real git repo) ──────────────────

const IntegrationTestLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	ChildProcessSpawnerLayer,
);

/**
 * Set up a minimal git repo in `workspace` with:
 * - An initial commit tagged as `origin/main`
 * - One or more commits on top (on branch `branchName`)
 */
function setupGitRepoForRunGeneratePrContent(
	workspace: string,
	commits: Array<{ message: string }>,
	branchName: string,
): Effect.Effect<void, Error, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const env = cleanGitEnv();
		const run = (args: string[]) =>
			spawner
				.string(ChildProcess.make("git", args, { cwd: workspace, env, extendEnv: false }))
				.pipe(Effect.mapError((e) => new Error(String(e))));

		yield* run(["init", "-b", branchName]);
		yield* run(["config", "user.email", "test@test.com"]);
		yield* run(["config", "user.name", "Test"]);
		yield* run(["config", "commit.gpgsign", "false"]);
		// Initial commit — this becomes origin/main
		yield* run(["commit", "--allow-empty", "-m", "chore: initial"]);
		yield* run(["update-ref", "refs/remotes/origin/main", "HEAD"]);

		// Add the test commits on top of origin/main
		for (const { message } of commits) {
			yield* run(["commit", "--allow-empty", "-m", message]);
		}
	});
}

describe("runGeneratePrContent (integration, real git repo)", () => {
	test("runGeneratePrContentWithServices uses injected git and PR services", async () => {
		const prior = "feat: existing PR title";
		const mockResponse = JSON.stringify({
			title: "feat: injected services",
			motivation: ["Uses injected GitContext and PullRequestClient."],
			benefits: [],
			risks: ["Low risk."],
			notesForReviewers: "",
		});
		let lookedUpBranch = "";
		const gitCtx = mockGitContext([
			{ subject: "feat: add module A", body: "" },
			{ subject: "fix: fix bug in B", body: "" },
		]);
		const prClient = {
			findByBranch: (branch: string) => {
				lookedUpBranch = branch;
				return Effect.succeed(
					Option.some({
						number: 123,
						url: "https://github.com/knirski/auto-pr/pull/123",
						title: prior,
					}),
				);
			},
			update: () => Effect.void,
			create: () => Effect.succeed("https://github.com/knirski/auto-pr/pull/123"),
		};

		await runEffect(
			Layer.mergeAll(
				ValueBasedLayer,
				Layer.succeed(GitContext, gitCtx),
				Layer.succeed(PullRequestClient, prClient),
				MockDiffToolkitLayer,
				aiProviderLayerFromConfig(
					{
						provider: "local",
						model: "gpt-oss",
					},
					{ fetch: createOpenAiMockFetchExpectingPromptSubstring(prior, mockResponse) },
				),
			),
		)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("run-generate-injected-");
				try {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					yield* runGeneratePrContentWithServices({
						defaultBranch: "main",
						branch: "ai/test",
						workspace: tmp.path,
						templatePath: tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						provider: "local",
						model: "gpt-oss",
						retryDelay: Duration.zero,
					});

					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					const body = yield* fs.readFileString(tmp.join("pr-body.md"));
					expect(lookedUpBranch).toBe("ai/test");
					expect(title.trim()).toBe("feat: injected services");
					expect(body).toContain("Uses injected GitContext and PullRequestClient.");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});

	test("program passes configured existing PR title into runGeneratePrContent", async () => {
		await runEffect(IntegrationTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("generate-program-existing-title-");
				try {
					yield* setupGitRepoForRunGeneratePrContent(
						tmp.path,
						[{ message: "feat: add x" }],
						"ai/test",
					);

					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					const configProviderLayer = ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							GITHUB_WORKSPACE: tmp.path,
							DEFAULT_BRANCH: "main",
							BRANCH: "ai/test",
							AUTO_PR_EXISTING_PR_TITLE: "  feat: existing title  ",
							AUTO_PR_AI_OPENAI_COMPAT_MODEL: "gpt-oss",
						}),
					);

					yield* program.pipe(Effect.provide(configProviderLayer));

					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					const body = yield* fs.readFileString(tmp.join("pr-body.md"));
					expect(title.trim()).toBe("feat: add x");
					expect(body).toContain("add x");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});

	test("program builds github-models run config for single-commit path", async () => {
		await runEffect(IntegrationTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("generate-program-github-models-");
				try {
					yield* setupGitRepoForRunGeneratePrContent(
						tmp.path,
						[{ message: "feat: add github models config" }],
						"ai/test",
					);

					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					const configProviderLayer = ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							GITHUB_WORKSPACE: tmp.path,
							DEFAULT_BRANCH: "main",
							BRANCH: "ai/test",
							AUTO_PR_AI_PROVIDER: "github-models",
							GH_TOKEN: "ghp_test_github_models",
						}),
					);

					yield* program.pipe(Effect.provide(configProviderLayer));

					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					const body = yield* fs.readFileString(tmp.join("pr-body.md"));
					expect(title.trim()).toBe("feat: add github models config");
					expect(body).toContain("github models config");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});

	test("writes pr-title.txt and pr-body.md for 1 commit (no AI call)", async () => {
		await runEffect(IntegrationTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("run-generate-");
				try {
					// Set up git repo
					yield* setupGitRepoForRunGeneratePrContent(
						tmp.path,
						[{ message: "feat: add x" }],
						"ai/test",
					);

					// Write the PR template
					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					// Run the pipeline
					yield* runGeneratePrContent({
						defaultBranch: "main",
						branch: "ai/test",
						workspace: tmp.path,
						templatePath: tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						provider: "local",
						model: "gpt-oss",
					});

					// Assert output files exist and have expected content
					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					const body = yield* fs.readFileString(tmp.join("pr-body.md"));
					expect(title.trim()).toBe("feat: add x");
					expect(body).toContain("add x");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});

	test("writes pr-title.txt and pr-body.md for 2 commits (AI call mocked)", async () => {
		await runEffect(IntegrationTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("run-generate-multi-");
				try {
					yield* setupGitRepoForRunGeneratePrContent(
						tmp.path,
						[{ message: "feat: add module A" }, { message: "fix: fix bug in B" }],
						"ai/test",
					);

					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					const mockResponse = JSON.stringify({
						title: "feat: add A and fix B",
						motivation: ["Improves module A and fixes bug in B."],
						benefits: [],
						risks: ["Low risk — covered by tests."],
						notesForReviewers: "",
					});

					yield* runGeneratePrContent({
						defaultBranch: "main",
						branch: "ai/test",
						workspace: tmp.path,
						templatePath: tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						provider: "local",
						model: "gpt-oss",
						retryDelay: Duration.zero,
						fetch: createOpenAiChatCompletionsMockFetch(mockResponse),
					});

					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					const body = yield* fs.readFileString(tmp.join("pr-body.md"));
					expect(title.trim()).toBe("feat: add A and fix B");
					expect(body).toContain("### Motivation");
					expect(body).toContain("### Risks");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});

	test("existingPrTitle is sent in the AI request for 2 commits", async () => {
		const prior = "feat: title from config";
		await runEffect(IntegrationTestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("run-generate-existing-title-");
				try {
					yield* setupGitRepoForRunGeneratePrContent(
						tmp.path,
						[{ message: "feat: add module A" }, { message: "fix: fix bug in B" }],
						"ai/test",
					);

					const fs = yield* FileSystem.FileSystem;
					yield* fs.makeDirectory(tmp.join(".github"), { recursive: true });
					yield* fs.writeFileString(tmp.join(".github/PULL_REQUEST_TEMPLATE.md"), DEFAULT_TEMPLATE);

					const mockResponse = JSON.stringify({
						title: "feat: config and AI",
						motivation: ["M."],
						benefits: [],
						risks: ["R."],
						notesForReviewers: "",
					});

					yield* runGeneratePrContent({
						defaultBranch: "main",
						branch: "ai/test",
						workspace: tmp.path,
						templatePath: tmp.join(".github/PULL_REQUEST_TEMPLATE.md"),
						provider: "local",
						model: "gpt-oss",
						existingPrTitle: prior,
						retryDelay: Duration.zero,
						fetch: createOpenAiMockFetchExpectingPromptSubstring(prior, mockResponse),
					});

					const title = yield* fs.readFileString(tmp.join("pr-title.txt"));
					expect(title.trim()).toBe("feat: config and AI");
				} finally {
					const fs = yield* FileSystem.FileSystem;
					yield* fs.remove(tmp.path, { recursive: true }).pipe(Effect.catch(() => Effect.void));
				}
			}).pipe(Effect.scoped),
		);
	});
});
