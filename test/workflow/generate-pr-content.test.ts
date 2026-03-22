import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Result } from "effect";
import {
	FillPrTemplateValidationError,
	NoSemanticCommitsError,
	ollamaLanguageModelLayer,
	ParseError,
	TemplateRenderError,
} from "#auto-pr";
import { runEffect } from "#test/run-effect.js";
import {
	createOllamaMockFetch,
	createTestTempDirEffect,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import type { GeneratePrContentFromValuesParams } from "#workflow/auto-pr-generate-content.js";
import {
	generatePrContentFromValues,
	normalizeUnknownToGeneratePrContentError,
	ollamaHostFromUrl,
	runGeneratePrContent,
} from "#workflow/auto-pr-generate-content.js";

function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const DEFAULT_TEMPLATE = "# PR\n\n{{description}}";
const TEMPLATE_WITH_CHANGES = "# PR\n\n{{description}}\n\n## Changes\n{{changes}}";
const DEFAULT_HOW_TO_TEST = "1. Run `npm run check`\n2. ";
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
		howToTestDefault: DEFAULT_HOW_TO_TEST,
		model: "llama3.1:8b",
		ollamaUrl: "http://localhost:11434/api/generate",
		...overrides,
	};
}

const ValueBasedLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);

function layerForGeneratePrContent(params: GeneratePrContentFromValuesParams) {
	return Layer.mergeAll(
		ValueBasedLayer,
		ollamaLanguageModelLayer(params.model, {
			host: ollamaHostFromUrl(params.ollamaUrl),
			...(params.fetch !== undefined && { fetch: params.fetch }),
		}),
	);
}

describe("generatePrContentFromValues (value-based, no file I/O)", () => {
	test("returns title and body for 1 commit (no Ollama)", async () => {
		const p = params([{ subject: "feat: add x", body: "" }]);
		await runEffect(
			Effect.gen(function* () {
				const result = yield* generatePrContentFromValues(p);
				expect(result.title).toBe("feat: add x");
				expect(result.body).toContain("add x");
				expect(result.count).toBe(1);
			}).pipe(Effect.scoped),
			layerForGeneratePrContent(p),
		);
	});

	test("fails with NoSemanticCommitsError when all commits are merge", async () => {
		const p = params([
			{ subject: "Merge branch 'main' into feature", body: "" },
			{ subject: "Merge pull request #1", body: "" },
		]);
		await runEffect(
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
			layerForGeneratePrContent(p),
		);
	});

	test("fails with TemplateRenderError when template is malformed", async () => {
		const p = params([{ subject: "feat: add x", body: "" }], {
			templateContent: "# PR\n\n{{description",
		});
		await runEffect(
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
			layerForGeneratePrContent(p),
		);
	});

	test("fails with FillPrTemplateValidationError when howToTestDefault empty and not docs-only", async () => {
		const p = params([{ subject: "feat: add x", body: "" }], {
			filesContent: "src/foo.ts\n",
			howToTestDefault: "",
		});
		await runEffect(
			Effect.gen(function* () {
				const exit = yield* generatePrContentFromValues(p).pipe(Effect.exit, Effect.scoped);
				expect(Exit.isFailure(exit)).toBe(true);
				if (Exit.isFailure(exit)) {
					Result.match(Cause.findError(exit.cause), {
						onSuccess: (err) => expect(err).toBeInstanceOf(FillPrTemplateValidationError),
						onFailure: () => expect().fail("expected Fail cause"),
					});
				}
			}).pipe(Effect.scoped),
			layerForGeneratePrContent(p),
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

	test("decodes class instances via Schema (FillPrTemplateValidationError)", () => {
		const validationErr = new FillPrTemplateValidationError({ message: "invalid" });
		const result = normalizeUnknownToGeneratePrContentError(validationErr);
		expect(result._tag).toBe("FillPrTemplateValidationError");
		expect((result as FillPrTemplateValidationError).message).toBe("invalid");
	});
});

const VALID_OLLAMA_RESPONSE =
	'{"title":"feat: add X and fix B","description":"Ollama-generated summary."}';
const INVALID_OLLAMA_RESPONSE = '{"title":"feat","description":"Invalid."}';

const twoCommits = [
	{ subject: "feat: add module A", body: "Adds A." },
	{ subject: "fix: fix bug in B", body: "Fixes B." },
];

describe("generatePrContentFromValues (2+ commits, mocked Ollama)", () => {
	describe("valid title", () => {
		test("returns Ollama title and body with description", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				fetch: createOllamaMockFetch(VALID_OLLAMA_RESPONSE),
			});
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add X and fix B");
					expect(result.body).toContain("Ollama-generated summary.");
					expect(result.body).toContain("feat: add module A");
					expect(result.body).toContain("fix: fix bug in B");
					expect(result.count).toBe(2);
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
			);
		});
	});

	describe("invalid title (fallback)", () => {
		test("falls back to first commit subject when Ollama returns invalid title 5 times", async () => {
			const p = params(twoCommits, {
				filesContent: "src/a.ts\nsrc/b.ts\n",
				templateContent: TEMPLATE_WITH_CHANGES,
				retryDelayMs: 0,
				fetch: createOllamaMockFetch(INVALID_OLLAMA_RESPONSE),
			});
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
					expect(result.count).toBe(2);
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
			);
		});

		test("falls back to chore: update when first commit subject is non-conventional", async () => {
			const p = params(
				[
					{ subject: "Add feature", body: "" },
					{ subject: "Fix bug", body: "" },
				],
				{ retryDelayMs: 0, fetch: createOllamaMockFetch(INVALID_OLLAMA_RESPONSE) },
			);
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("chore: update");
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
			);
		});
	});

	describe("Ollama empty response", () => {
		test("falls back when Ollama returns empty response 5 times", async () => {
			const p = params(twoCommits, {
				retryDelayMs: 0,
				fetch: createOllamaMockFetch(""),
			});
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
			);
		});
	});

	describe("Ollama title-only (no description)", () => {
		test("falls back when Ollama returns invalid JSON 5 times", async () => {
			const p = params(twoCommits, {
				retryDelayMs: 0,
				fetch: createOllamaMockFetch("feat: x\n\n"),
			});
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
			);
		});
	});

	describe("Ollama HTTP 500", () => {
		test("falls back when Ollama returns HTTP 500 five times", async () => {
			const p = params(twoCommits, {
				retryDelayMs: 0,
				fetch: createOllamaMockFetch({
					response: VALID_OLLAMA_RESPONSE,
					status: 500,
				}),
			});
			await runEffect(
				Effect.gen(function* () {
					const result = yield* generatePrContentFromValues(p);
					expect(result.title).toBe("feat: add module A");
				}).pipe(Effect.scoped),
				layerForGeneratePrContent(p),
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
	test("reads files, writes title and body_file to GITHUB_OUTPUT and pr-body.md", async () => {
		await runEffect(
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
					fetch: createOllamaMockFetch(""),
				});

				const ghContent = yield* fs.readFileString(ghOutput);
				expect(ghContent).toContain("title=");
				expect(ghContent).toContain("body_file=");

				const bodyPath = pathApi.join(tmp.path, "pr-body.md");
				const bodyContent = yield* fs.readFileString(bodyPath);
				expect(bodyContent).toContain("add x");
			}).pipe(Effect.scoped),
			RunIntegrationLayer,
		);
	});
});
