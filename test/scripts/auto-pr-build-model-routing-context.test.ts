import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	program,
	runBuildModelRoutingContext,
} from "../../.github/actions/auto-pr-build-model-routing-context/auto-pr-build-model-routing-context.js";

function runGit(cwd: string, args: readonly string[]): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
			if (result.status !== 0) {
				throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
			}
		},
		catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
	});
}

function write(path: string, content: string): Effect.Effect<void, Error> {
	return Effect.sync(() => {
		writeFileSync(path, content);
	});
}

function read(path: string): Effect.Effect<string, Error> {
	return Effect.sync(() => readFileSync(path, "utf8"));
}

function tempRepo(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("build-model-routing-context", () => {
	test("emits a default model and signal summary for single-commit PRs", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* Effect.sync(() => mkdirSync(join(dir, "docs"), { recursive: true }));
					yield* write(join(dir, "docs", "base.md"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);

					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* Effect.sync(() => mkdirSync(join(dir, "src"), { recursive: true }));
					yield* write(join(dir, "src", "app.ts"), "export const app = 1;\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: add app"]);

					const githubOutput = join(dir, "github_output");
					yield* runBuildModelRoutingContext({
						workspace: dir,
						defaultBranch: "main",
						provider: "local",
						explicitModel: undefined,
						githubOutput,
						commitsCount: 1,
					});

					const output = yield* read(githubOutput);
					expect(output).toContain("selected_model=gpt-oss");
					expect(output).toContain("band=A");
					expect(output).toContain("tool_strategy=none");
					expect(output).toContain("reasoning_need=low");
					expect(output).toContain("requires_tool_calls=false");
					expect(output).toContain("routing_context<<");
					expect(output).toContain("decision: band=A; reason=tight / docs-only / generated-heavy");
					expect(output).toContain("intent: 1 semantic commit; merge=0; breaking=0; types=feat=1");
					expect(output).toContain("scope: source-only; dirs=src");
					expect(output).toContain(
						"churn: raw=1; source=1; generated=0; generated-share=0%; source-share=100%",
					);
					expect(output).toContain("hotspots: files=src/app.ts (+1/-0, source)");
					expect(output).toContain("review_focus: src/app.ts (+1/-0, source)");
					expect(output).toContain("tool_guidance: no tools needed");
					expect(output).toContain(
						"model_route: band=A; reasoning=low; tool_strategy=none; requires_tool_calls=false; selected_model=gpt-oss",
					);
					expect(output).not.toContain("subjects:");
					expect(output).not.toContain("compact:");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("respects an explicit model override", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-override-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* write(join(dir, "base.txt"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* write(join(dir, "change.txt"), "change\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: change"]);

					const githubOutput = join(dir, "github_output");
					yield* runBuildModelRoutingContext({
						workspace: dir,
						defaultBranch: "main",
						provider: "github-models",
						explicitModel: "openai/gpt-4.1",
						githubOutput,
						commitsCount: 1,
					});

					const output = yield* read(githubOutput);
					expect(output).toContain("selected_model=openai/gpt-4.1");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("classifies dependency manifests separately from generated files", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-deps-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* write(join(dir, "base.txt"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* write(join(dir, "package.json"), '{"dependencies":{"left-pad":"1.3.0"}}\n');
					yield* write(join(dir, "bun.lock"), "left-pad@1.3.0\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "build: update dependencies"]);

					const githubOutput = join(dir, "github_output");
					yield* runBuildModelRoutingContext({
						workspace: dir,
						defaultBranch: "main",
						provider: "github-models",
						explicitModel: undefined,
						githubOutput,
						commitsCount: 1,
					});

					const output = yield* read(githubOutput);
					expect(output).toContain(
						"file-kinds: source=0; docs=0; test=0; generated=0; lockfiles=1; package-manifests=1",
					);
					expect(output).toContain("sensitive_scope: dependencies");
					expect(output).not.toContain("generated-heavy");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("program reads required env vars and emits routing outputs", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-program-");
		const originalEnv = {
			AI_PROVIDER: process.env.AI_PROVIDER,
			COMMITS_COUNT: process.env.COMMITS_COUNT,
			DEFAULT_BRANCH: process.env.DEFAULT_BRANCH,
			GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
			INPUT_MODEL: process.env.INPUT_MODEL,
			WORKSPACE: process.env.WORKSPACE,
		};
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* Effect.sync(() => mkdirSync(join(dir, "src"), { recursive: true }));
					yield* write(join(dir, "src", "app.ts"), "export const app = 1;\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: add app"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* write(join(dir, "src", "app.ts"), "export const app = 2;\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: update app"]);

					const githubOutput = join(dir, "github_output");
					process.env.WORKSPACE = dir;
					process.env.DEFAULT_BRANCH = "main";
					process.env.AI_PROVIDER = "local";
					process.env.INPUT_MODEL = "";
					process.env.GITHUB_OUTPUT = githubOutput;
					process.env.COMMITS_COUNT = "1";

					yield* program;

					const output = yield* read(githubOutput);
					expect(output).toContain("selected_model=gpt-oss");
					expect(output).toContain("band=A");
					expect(output).toContain("routing_context<<");
					expect(output).toContain("decision:");
					expect(output).toContain("model_route:");
				}),
			);
		} finally {
			process.env.AI_PROVIDER = originalEnv.AI_PROVIDER;
			process.env.COMMITS_COUNT = originalEnv.COMMITS_COUNT;
			process.env.DEFAULT_BRANCH = originalEnv.DEFAULT_BRANCH;
			process.env.GITHUB_OUTPUT = originalEnv.GITHUB_OUTPUT;
			process.env.INPUT_MODEL = originalEnv.INPUT_MODEL;
			process.env.WORKSPACE = originalEnv.WORKSPACE;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
