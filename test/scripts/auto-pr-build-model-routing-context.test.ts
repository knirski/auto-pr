import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	program,
	runBuildModelRoutingContext,
} from "../../src/workflow/auto-pr-build-model-routing-context.js";

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
	test("routing context is a packaged command instead of an action-local compiled bundle", () => {
		const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
			bin: Record<string, string>;
			scripts: Record<string, string>;
		};
		const buildScript = readFileSync(join(process.cwd(), "scripts/build.ts"), "utf8");
		const runCommandAction = readFileSync(
			join(process.cwd(), ".github/actions/auto-pr-run-command/action.yml"),
			"utf8",
		);
		const runCommandScript = readFileSync(
			join(process.cwd(), ".github/actions/auto-pr-run-command/auto-pr-run-command.sh"),
			"utf8",
		);

		expect(pkg.bin["auto-pr-build-model-routing-context"]).toBe(
			"./dist/workflow/auto-pr-build-model-routing-context.js",
		);
		expect(pkg.scripts["build-model-routing-context"]).toBe(
			"bun run src/workflow/auto-pr-build-model-routing-context.ts",
		);
		expect(buildScript).not.toContain("auto-pr-build-model-routing-context.mjs");
		expect(
			existsSync(
				join(
					process.cwd(),
					".github/actions/auto-pr-build-model-routing-context/auto-pr-build-model-routing-context.mjs",
				),
			),
		).toBe(false);
		expect(runCommandAction).toContain("selected_model:");
		expect(runCommandAction).toContain("routing_context:");
		expect(runCommandScript).toContain("build-model-routing-context)");
		expect(runCommandScript).toContain('BIN="auto-pr-build-model-routing-context"');
		expect(runCommandScript).toContain('SCRIPT="build-model-routing-context"');
	});

	test("auto-pr-run-command invokes build-model-routing-context from workspace source", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-command-");
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
				}),
			);

			const githubOutput = join(dir, "github_output");
			const result = spawnSync(
				"bash",
				[
					join(process.cwd(), ".github/actions/auto-pr-run-command/auto-pr-run-command.sh"),
					"build-model-routing-context",
				],
				{
					cwd: process.cwd(),
					encoding: "utf8",
					env: {
						...process.env,
						AUTO_PR_AI_PROVIDER: "local",
						AUTO_PR_AI_OPENAI_COMPAT_MODEL: "",
						AUTO_PR_AI_OPENAI_COMPAT_URL: "",
						AUTO_PR_AI_LLAMACPP_MODEL_URL: "",
						AUTO_PR_PKG: "github:knirski/auto-pr",
						COMMITS_COUNT: "1",
						DEFAULT_BRANCH: "main",
						GITHUB_OUTPUT: githubOutput,
						GITHUB_WORKSPACE: dir,
						REPOSITORY_VISIBILITY: "private",
						RUNNER: "npx",
						RUNNER_LABEL: "ubuntu-24.04",
						USE_WORKSPACE: "true",
					},
				},
			);

			expect(result.status).toBe(0);
			expect(readFileSync(githubOutput, "utf8")).toContain("selected_model=qwen3-1.7b-q4_k_m");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("packaged command runs with Node from built dist", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-node-");
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
				}),
			);

			const githubOutput = join(dir, "github_output");
			const result = spawnSync(
				process.execPath,
				[join(process.cwd(), "dist/workflow/auto-pr-build-model-routing-context.js")],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						AUTO_PR_AI_PROVIDER: "local",
						AUTO_PR_AI_OPENAI_COMPAT_MODEL: "",
						AUTO_PR_AI_OPENAI_COMPAT_URL: "",
						AUTO_PR_AI_LLAMACPP_MODEL_URL: "",
						COMMITS_COUNT: "1",
						DEFAULT_BRANCH: "main",
						GITHUB_OUTPUT: githubOutput,
						GITHUB_WORKSPACE: dir,
						REPOSITORY_VISIBILITY: "private",
						RUNNER_LABEL: "ubuntu-24.04",
					},
				},
			);

			expect(result.status).toBe(0);
			expect(result.stderr).toBe("");
			expect(readFileSync(githubOutput, "utf8")).toContain("selected_model=qwen3-1.7b-q4_k_m");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("treats root-only files as one top-level directory", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-root-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* write(join(dir, "README.md"), "base\n");
					yield* write(join(dir, "package.json"), '{"name":"base"}\n');
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "chore: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* write(join(dir, "README.md"), "updated\n");
					yield* write(join(dir, "package.json"), '{"name":"feature"}\n');
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: update root files"]);

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
					expect(output).toContain("dirs=<root>");
					expect(output).toContain(
						"file-kinds: source=0; docs=1; test=0; generated=0; lockfiles=0; package-manifests=1",
					);
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("classifies src test files as tests before source", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-tests-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* Effect.sync(() => mkdirSync(join(dir, "src"), { recursive: true }));
					yield* write(join(dir, "src", "base.ts"), "export const base = 1;\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* write(join(dir, "src", "foo.test.ts"), "expect(true).toBe(true);\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "test: add co-located test"]);

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
					expect(output).toContain(
						"file-kinds: source=0; docs=0; test=1; generated=0; lockfiles=0; package-manifests=0",
					);
					expect(output).toContain("review_focus: src/foo.test.ts (+1/-0, test)");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

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
					expect(output).toContain("selected_model=qwen3-1.7b-q4_k_m");
					expect(output).toContain("band=A");
					expect(output).toContain("tool_strategy=none");
					expect(output).toContain("reasoning_need=low");
					expect(output).toContain("requires_tool_calls=false");
					expect(output).toContain(
						"local_runner_resources=github-hosted ubuntu-24.04 private/internal baseline; cpu=2; memory=8GB",
					);
					expect(output).toContain("local_model_resource_fit=unknown");
					expect(output).toContain(
						"local_model_recommendation=qwen3-1.7b-q4_k_m; recommended GGUF <= 3B Q4-class on this runner",
					);
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
						"model_route: band=A; reasoning=low; tool_strategy=none; requires_tool_calls=false; selected_model=qwen3-1.7b-q4_k_m",
					);
					expect(output).not.toContain("subjects:");
					expect(output).not.toContain("compact:");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("does not count docs-only churn as source churn", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-docs-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* write(join(dir, "README.md"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);

					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* Effect.sync(() => mkdirSync(join(dir, "docs"), { recursive: true }));
					yield* write(
						join(dir, "docs", "guide.md"),
						Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"),
					);
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: add guide"]);

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
					expect(output).toContain("file-kinds: source=0; docs=1");
					expect(output).toContain("churn: raw=40; source=0; generated=0");
					expect(output).toContain("source-share=0%");
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
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("program reads required env vars and emits routing outputs", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-program-");
		const originalEnv = {
			AUTO_PR_AI_LLAMACPP_MODEL_URL: process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL,
			AUTO_PR_AI_OPENAI_COMPAT_MODEL: process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL,
			AUTO_PR_AI_OPENAI_COMPAT_URL: process.env.AUTO_PR_AI_OPENAI_COMPAT_URL,
			AUTO_PR_AI_PROVIDER: process.env.AUTO_PR_AI_PROVIDER,
			COMMITS_COUNT: process.env.COMMITS_COUNT,
			DEFAULT_BRANCH: process.env.DEFAULT_BRANCH,
			GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
			GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
			LOCAL_RUNNER_CPUS: process.env.LOCAL_RUNNER_CPUS,
			LOCAL_RUNNER_MEMORY_GB: process.env.LOCAL_RUNNER_MEMORY_GB,
			REPOSITORY_VISIBILITY: process.env.REPOSITORY_VISIBILITY,
			RUNNER_LABEL: process.env.RUNNER_LABEL,
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
					process.env.GITHUB_OUTPUT = githubOutput;
					process.env.GITHUB_WORKSPACE = dir;
					process.env.DEFAULT_BRANCH = "main";
					process.env.AUTO_PR_AI_PROVIDER = "local";
					process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL = "";
					process.env.AUTO_PR_AI_OPENAI_COMPAT_URL = "";
					process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL = "";
					process.env.LOCAL_RUNNER_CPUS = "";
					process.env.LOCAL_RUNNER_MEMORY_GB = "";
					process.env.REPOSITORY_VISIBILITY = "private";
					process.env.RUNNER_LABEL = "ubuntu-24.04";
					process.env.COMMITS_COUNT = "1";

					yield* program;

					const output = yield* read(githubOutput);
					expect(output).toContain("selected_model=qwen3-1.7b-q4_k_m");
					expect(output).toContain("band=A");
					expect(output).toContain("routing_context<<");
					expect(output).toContain("decision:");
					expect(output).toContain("model_route:");
				}),
			);
		} finally {
			process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL = originalEnv.AUTO_PR_AI_LLAMACPP_MODEL_URL;
			process.env.AUTO_PR_AI_OPENAI_COMPAT_MODEL = originalEnv.AUTO_PR_AI_OPENAI_COMPAT_MODEL;
			process.env.AUTO_PR_AI_OPENAI_COMPAT_URL = originalEnv.AUTO_PR_AI_OPENAI_COMPAT_URL;
			process.env.AUTO_PR_AI_PROVIDER = originalEnv.AUTO_PR_AI_PROVIDER;
			process.env.COMMITS_COUNT = originalEnv.COMMITS_COUNT;
			process.env.DEFAULT_BRANCH = originalEnv.DEFAULT_BRANCH;
			process.env.GITHUB_OUTPUT = originalEnv.GITHUB_OUTPUT;
			process.env.GITHUB_WORKSPACE = originalEnv.GITHUB_WORKSPACE;
			process.env.LOCAL_RUNNER_CPUS = originalEnv.LOCAL_RUNNER_CPUS;
			process.env.LOCAL_RUNNER_MEMORY_GB = originalEnv.LOCAL_RUNNER_MEMORY_GB;
			process.env.REPOSITORY_VISIBILITY = originalEnv.REPOSITORY_VISIBILITY;
			process.env.RUNNER_LABEL = originalEnv.RUNNER_LABEL;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
