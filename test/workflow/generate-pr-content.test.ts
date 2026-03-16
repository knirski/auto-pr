import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Result } from "effect";
import * as Http from "effect/unstable/http";
import { FillPrTemplate, NoSemanticCommitsError } from "#auto-pr";
import {
	createTestTempDirEffect,
	FillPrTemplateTestMock,
	SilentLoggerLayer,
	TestBaseLayer,
} from "#test/test-utils.js";
import { runGeneratePrContent } from "#workflow/generate-pr-content.js";

/** Format commit blocks for parseCommits (---COMMIT--- separated). */
function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const TestLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	FillPrTemplateTestMock({ title: "feat: add x", body: "# Mock body\n\nfeat: add x" }),
	Http.FetchHttpClient.layer,
);

/** Full pipeline with real FillPrTemplate and mocked Ollama (for 2+ commits). */
const IntegrationLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	FillPrTemplate.Live,
	Http.FetchHttpClient.layer,
);

layer(TestLayer)("runGeneratePrContent", (it) => {
	it.effect("writes title and body_file to GITHUB_OUTPUT for 1 commit (no Ollama)", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("generate-pr-content-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			const commitsPath = pathApi.join(tmp.path, "commits.txt");
			const filesPath = pathApi.join(tmp.path, "files.txt");
			const ghOutput = pathApi.join(tmp.path, "github_output.txt");

			yield* fs.writeFileString(commitsPath, logContent({ subject: "feat: add x", body: "" }));
			yield* fs.writeFileString(filesPath, "src/foo.ts\n");

			const templatePath = pathApi.join(tmp.path, "template.md");
			yield* fs.writeFileString(templatePath, "# PR\n\n{{description}}");

			const config = {
				commits: commitsPath,
				files: filesPath,
				ghOutput,
				workspace: tmp.path,
				templatePath,
				model: "llama3.1:8b",
				ollamaUrl: "http://localhost:11434/api/generate",
				howToTestDefault: "1. Run `npm run check`\n2. ",
			};

			yield* runGeneratePrContent(config);

			const content = yield* fs.readFileString(ghOutput);
			expect(content).toContain("title=");
			expect(content).toContain("body_file=");

			const bodyPath = pathApi.join(tmp.path, "pr-body.md");
			const bodyContent = yield* fs.readFileString(bodyPath);
			expect(bodyContent).toContain("feat: add x");
		}).pipe(Effect.scoped),
	);

	it.effect("fails with NoSemanticCommitsError when all commits are merge", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("generate-pr-content-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			const commitsPath = pathApi.join(tmp.path, "commits.txt");
			const filesPath = pathApi.join(tmp.path, "files.txt");
			const ghOutput = pathApi.join(tmp.path, "github_output.txt");

			yield* fs.writeFileString(
				commitsPath,
				logContent(
					{ subject: "Merge branch 'main' into feature", body: "" },
					{ subject: "Merge pull request #1", body: "" },
				),
			);
			yield* fs.writeFileString(filesPath, "src/foo.ts\n");

			const templatePath = pathApi.join(tmp.path, "template.md");
			yield* fs.writeFileString(templatePath, "# PR\n\n{{description}}");

			const config = {
				commits: commitsPath,
				files: filesPath,
				ghOutput,
				workspace: tmp.path,
				templatePath,
				model: "llama3.1:8b",
				ollamaUrl: "http://localhost:11434/api/generate",
				howToTestDefault: "1. Run `npm run check`\n2. ",
			};

			const exit = yield* runGeneratePrContent(config).pipe(Effect.exit, Effect.scoped);
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

layer(IntegrationLayer)("runGeneratePrContent integration (2+ commits, mocked Ollama)", (it) => {
	it.effect("calls Ollama, writes title and description, uses both in output", () =>
		Effect.gen(function* () {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = () =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							response: "feat: add X and fix B\n\nOllama-generated summary.",
						}),
					),
				);
			try {
				const tmp = yield* createTestTempDirEffect("generate-pr-content-2commits-");
				const fs = yield* FileSystem.FileSystem;
				const pathApi = yield* Path.Path;

				const commitsPath = pathApi.join(tmp.path, "commits.txt");
				const filesPath = pathApi.join(tmp.path, "files.txt");
				const ghOutput = pathApi.join(tmp.path, "github_output.txt");

				yield* fs.writeFileString(
					commitsPath,
					logContent(
						{ subject: "feat: add module A", body: "Adds A." },
						{ subject: "fix: fix bug in B", body: "Fixes B." },
					),
				);
				yield* fs.writeFileString(filesPath, "src/a.ts\nsrc/b.ts\n");

				const templatePath = pathApi.join(tmp.path, "template.md");
				yield* fs.writeFileString(
					templatePath,
					"# PR\n\n{{description}}\n\n## Changes\n{{changes}}",
				);

				const config = {
					commits: commitsPath,
					files: filesPath,
					ghOutput,
					workspace: tmp.path,
					templatePath,
					model: "llama3.1:8b",
					ollamaUrl: "http://localhost:11434/api/generate",
					howToTestDefault: "1. Run `npm run check`\n2. ",
				};

				yield* runGeneratePrContent(config);

				const descriptionPath = pathApi.join(tmp.path, "description.txt");
				const descriptionContent = yield* fs.readFileString(descriptionPath);
				expect(descriptionContent).toBe("Ollama-generated summary.");

				const bodyPath = pathApi.join(tmp.path, "pr-body.md");
				const bodyContent = yield* fs.readFileString(bodyPath);
				expect(bodyContent).toContain("Ollama-generated summary.");
				expect(bodyContent).toContain("feat: add module A");
				expect(bodyContent).toContain("fix: fix bug in B");

				const ghContent = yield* fs.readFileString(ghOutput);
				expect(ghContent).toContain("title=");
				expect(ghContent).toContain("body_file=");
				expect(ghContent).toContain("feat: add X and fix B");
			} finally {
				globalThis.fetch = originalFetch;
			}
		}).pipe(Effect.scoped),
	);
});
