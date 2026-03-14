import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import * as Http from "effect/unstable/http";
import { FillPrTemplateLiveLayer } from "../../scripts/auto-pr/index.js";
import { runGeneratePrContent } from "../../scripts/generate-pr-content.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "../test-utils.js";

/** Format commit blocks for parseCommits (---COMMIT--- separated). */
function logContent(...blocks: Array<{ subject: string; body: string }>): string {
	const formatted = blocks.map((b) => (b.body ? `${b.subject}\n\n${b.body}`.trim() : b.subject));
	return `---COMMIT---\n${formatted.join("\n---COMMIT---\n")}`;
}

const TestLayer = Layer.mergeAll(
	TestBaseLayer,
	SilentLoggerLayer,
	FillPrTemplateLiveLayer,
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

			const config = {
				commits: commitsPath,
				files: filesPath,
				ghOutput,
				workspace: tmp.path,
				model: "llama3.1:8b",
				ollamaUrl: "http://localhost:11434/api/generate",
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
});
