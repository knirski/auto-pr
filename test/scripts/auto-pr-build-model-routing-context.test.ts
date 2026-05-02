import { describe, expect, test } from "bun:test";
import { Effect, Match } from "effect";
import {
	RoutingContextEnvError,
	RoutingContextGitError,
	RoutingContextParseError,
} from "#core/errors.js";
import {
	program,
	reportProgramError,
	runBuildModelRoutingContext,
} from "../../src/workflow/auto-pr-build-model-routing-context.js";

type SpawnSyncResult = {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
};

type CommandSuccess = SpawnSyncResult & {
	readonly _tag: "Success";
	readonly status: 0;
};

type CommandFailure = SpawnSyncResult & {
	readonly _tag: "Failure";
};

type CommandResult = CommandSuccess | CommandFailure;

const textDecoder = new TextDecoder();

function toError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function join(...parts: readonly string[]): string {
	return parts
		.filter((part) => part.length > 0)
		.map((part, index) =>
			index === 0 ? part.replace(/[\\/]+$/g, "") : part.replace(/^[/\\]+|[/\\]+$/g, ""),
		)
		.join("/");
}

function spawnSync(
	command: string,
	args: readonly string[],
	options?: {
		readonly cwd?: string;
		readonly encoding?: "utf8";
		readonly env?: Record<string, string | undefined>;
	},
): CommandResult {
	const env =
		options?.env === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(options.env).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				);
	const result = Bun.spawnSync([command, ...args], {
		...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
		...(env === undefined ? {} : { env }),
		stdout: "pipe",
		stderr: "pipe",
	});
	const output: SpawnSyncResult = {
		status: result.exitCode,
		stdout: textDecoder.decode(result.stdout),
		stderr: textDecoder.decode(result.stderr),
	};
	return Match.value(output.status).pipe(
		Match.when(0, () => ({ ...output, _tag: "Success" as const, status: 0 as const })),
		Match.orElse(() => ({ ...output, _tag: "Failure" as const })),
	);
}

function requireCommandSuccess(
	command: string,
	args: readonly string[],
	result: CommandResult,
): CommandSuccess {
	return Match.value(result).pipe(
		Match.when({ _tag: "Success" }, (success) => success),
		Match.when({ _tag: "Failure" }, (failure) => {
			throw new Error(`${command} ${args.join(" ")} failed: ${failure.stderr || failure.stdout}`);
		}),
		Match.exhaustive,
	);
}

function existsSync(path: string): boolean {
	return Match.value(spawnSync("test", ["-e", path])).pipe(
		Match.when({ _tag: "Success" }, () => true),
		Match.when({ _tag: "Failure" }, () => false),
		Match.exhaustive,
	);
}

function mkdirSync(path: string, options?: { readonly recursive?: boolean }): void {
	const args = [options?.recursive === true ? "-p" : "", path].filter((arg) => arg !== "");
	requireCommandSuccess("mkdir", args, spawnSync("mkdir", args));
}

function rmSync(
	path: string,
	options?: {
		readonly recursive?: boolean;
		readonly force?: boolean;
	},
): void {
	const args = [
		options?.recursive === true ? "-r" : "",
		options?.force === true ? "-f" : "",
		path,
	].filter((arg) => arg !== "");
	requireCommandSuccess("rm", args, spawnSync("rm", args));
}

function tmpdir(): string {
	return process.env.TMPDIR?.trim() || "/tmp";
}

function mkdtempSync(prefixPath: string): string {
	const result = requireCommandSuccess(
		"mktemp",
		["-d", `${prefixPath}XXXXXX`],
		spawnSync("mktemp", ["-d", `${prefixPath}XXXXXX`]),
	);
	return result.stdout.trim();
}

function readFileSync(path: string, encoding: "utf8"): string {
	if (encoding !== "utf8") {
		throw new Error(`Unsupported encoding: ${encoding}`);
	}
	const result = requireCommandSuccess("cat", [path], spawnSync("cat", [path]));
	return result.stdout;
}

function runGit(cwd: string, args: readonly string[]): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			requireCommandSuccess("git", args, spawnSync("git", [...args], { cwd, encoding: "utf8" }));
		},
		catch: toError,
	});
}

function write(path: string, content: string): Effect.Effect<void, Error> {
	return Effect.tryPromise({
		try: () => Bun.write(path, content).then(() => undefined),
		catch: toError,
	});
}

function read(path: string): Effect.Effect<string, Error> {
	return Effect.try({
		try: () => readFileSync(path, "utf8"),
		catch: toError,
	});
}

function mkdir(
	path: string,
	options?: { readonly recursive?: boolean },
): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			mkdirSync(path, options);
		},
		catch: toError,
	});
}

function tempRepo(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function withPatchedEnv(
	patch: Record<string, string | undefined>,
	run: () => Promise<void>,
): Promise<void> {
	const original: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(patch)) {
		original[key] = process.env[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	return run().finally(() => {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});
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

					yield* mkdir(join(dir, "src"), { recursive: true });
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

					yield* mkdir(join(dir, "src"), { recursive: true });
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

	test("auto-pr-run-command package mode executes packaged routing binary via runner", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-package-mode-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* mkdir(join(dir, "src"), { recursive: true });
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

			const argsFile = join(dir, "runner_args.txt");
			const runnerScript = join(dir, "mock-runner.sh");
			const githubOutput = join(dir, "github_output");
			await Effect.runPromise(
				write(
					runnerScript,
					[
						"#!/usr/bin/env bash",
						"set -euo pipefail",
						'printf "%s\\n" "$@" > "$RUNNER_ARGS_FILE"',
						'node "$AUTO_PR_BIN_PATH"',
					].join("\n"),
				),
			);
			requireCommandSuccess(
				"chmod",
				["+x", runnerScript],
				spawnSync("chmod", ["+x", runnerScript]),
			);

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
						AUTO_PR_BIN_PATH: join(
							process.cwd(),
							"dist/workflow/auto-pr-build-model-routing-context.js",
						),
						AUTO_PR_PKG: "github:knirski/auto-pr",
						COMMITS_COUNT: "1",
						DEFAULT_BRANCH: "main",
						GITHUB_OUTPUT: githubOutput,
						GITHUB_WORKSPACE: dir,
						REPOSITORY_VISIBILITY: "private",
						RUNNER: runnerScript,
						RUNNER_ARGS_FILE: argsFile,
						RUNNER_LABEL: "ubuntu-24.04",
						USE_WORKSPACE: "false",
					},
				},
			);

			expect(result.status).toBe(0);
			expect(readFileSync(argsFile, "utf8")).toContain("-p");
			expect(readFileSync(argsFile, "utf8")).toContain("github:knirski/auto-pr");
			expect(readFileSync(argsFile, "utf8")).toContain("auto-pr-build-model-routing-context");
			expect(readFileSync(githubOutput, "utf8")).toContain("selected_model=qwen3-1.7b-q4_k_m");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reusable generate workflow wires routing outputs into generate-content env", () => {
		const workflow = readFileSync(
			join(process.cwd(), ".github/workflows/auto-pr-generate-reusable.yml"),
			"utf8",
		);
		expect(workflow).toContain(
			"AUTO_PR_AI_OPENAI_COMPAT_MODEL: $" +
				"{{ steps.local_llama.outputs.model_id || steps.ai_routing.outputs.selected_model }}",
		);
		expect(workflow).toContain(
			"AUTO_PR_ROUTING_CONTEXT: $" + "{{ steps.ai_routing.outputs.routing_context }}",
		);
	});

	test("reusable generate workflow fetches origin/default before routing and generation", () => {
		const workflow = readFileSync(
			join(process.cwd(), ".github/workflows/auto-pr-generate-reusable.yml"),
			"utf8",
		);
		const fetchIndex = workflow.indexOf("name: Fetch base branch");
		const routingIndex = workflow.indexOf("name: Build model routing context");
		const generateIndex = workflow.indexOf("name: Generate PR content");

		expect(fetchIndex).toBeGreaterThanOrEqual(0);
		expect(routingIndex).toBeGreaterThanOrEqual(0);
		expect(generateIndex).toBeGreaterThanOrEqual(0);
		expect(fetchIndex).toBeLessThan(routingIndex);
		expect(fetchIndex).toBeLessThan(generateIndex);
		expect(workflow).toContain('run: git fetch origin "$DEFAULT_BRANCH"');
	});

	test("emits a default model and signal summary for single-commit PRs", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* mkdir(join(dir, "docs"), { recursive: true });
					yield* write(join(dir, "docs", "base.md"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					yield* runGit(dir, ["branch", "origin/main"]);

					yield* runGit(dir, ["checkout", "-b", "feature"]);
					yield* mkdir(join(dir, "src"), { recursive: true });
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
					yield* mkdir(join(dir, "docs"), { recursive: true });
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

					yield* mkdir(join(dir, "src"), { recursive: true });
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

	test("program fails when required env vars are missing", async () => {
		await withPatchedEnv(
			{
				GITHUB_WORKSPACE: undefined,
				DEFAULT_BRANCH: "main",
				AUTO_PR_AI_PROVIDER: "local",
				GITHUB_OUTPUT: join(tempRepo("auto-pr-build-model-routing-context-missing-env-"), "out"),
			},
			async () => {
				const error = await Effect.runPromise(program.pipe(Effect.flip));
				expect(error).toBeInstanceOf(RoutingContextEnvError);
				expect(error).toMatchObject({
					_tag: "RoutingContextEnvError",
					name: "GITHUB_WORKSPACE",
				});
			},
		);
	});

	test("program rejects invalid numeric env values", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-invalid-env-");
		const output = join(dir, "github_output");
		await withPatchedEnv(
			{
				GITHUB_WORKSPACE: dir,
				DEFAULT_BRANCH: "main",
				AUTO_PR_AI_PROVIDER: "local",
				GITHUB_OUTPUT: output,
				COMMITS_COUNT: "-1",
				LOCAL_RUNNER_CPUS: "0",
				LOCAL_RUNNER_MEMORY_GB: "bad",
			},
			async () => {
				const error = await Effect.runPromise(program.pipe(Effect.flip));
				expect(error).toBeInstanceOf(RoutingContextParseError);
				expect(error).toMatchObject({
					_tag: "RoutingContextParseError",
					name: "COMMITS_COUNT",
					requirement: "a non-negative integer",
					value: "-1",
				});
			},
		);
	});

	test("fails when git base ref cannot be resolved", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-git-fail-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);
					yield* write(join(dir, "README.md"), "base\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "docs: base"]);
					// Intentionally do not create origin/main alias to force git diff failure.
					const githubOutput = join(dir, "github_output");
					const error = yield* runBuildModelRoutingContext({
						workspace: dir,
						defaultBranch: "main",
						provider: "github-models",
						explicitModel: undefined,
						githubOutput,
						commitsCount: 1,
					}).pipe(Effect.flip);
					expect(error).toBeInstanceOf(RoutingContextGitError);
					expect(error).toMatchObject({
						_tag: "RoutingContextGitError",
						command: "diff --name-only origin/main..HEAD",
					});
					expect(error.cause).toContain("unknown revision");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("tracks generated/test kinds and aggregates churn per top directory", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-kinds-");
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* runGit(dir, ["init", "-b", "main"]);
					yield* runGit(dir, ["config", "user.email", "test@example.com"]);
					yield* runGit(dir, ["config", "user.name", "Test User"]);

					yield* mkdir(join(dir, "src"), { recursive: true });
					yield* mkdir(join(dir, "test"), { recursive: true });
					yield* mkdir(join(dir, "dist"), { recursive: true });
					yield* write(join(dir, "src", "a.ts"), "export const a = 1;\n");
					yield* write(join(dir, "src", "b.ts"), "export const b = 1;\n");
					yield* write(join(dir, "test", "a.test.ts"), "test('a', () => {});\n");
					yield* write(join(dir, "dist", "bundle.js.map"), "{}\n");
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: base files"]);
					yield* runGit(dir, ["branch", "origin/main"]);
					yield* runGit(dir, ["checkout", "-b", "feature"]);

					yield* write(join(dir, "src", "a.ts"), "export const a = 2;\n");
					yield* write(join(dir, "src", "b.ts"), "export const b = 2;\n");
					yield* write(
						join(dir, "test", "a.test.ts"),
						"test('a', () => { expect(1).toBe(1); });\n",
					);
					yield* write(join(dir, "dist", "bundle.js.map"), '{"version":3}\n');
					yield* runGit(dir, ["add", "."]);
					yield* runGit(dir, ["commit", "-m", "feat: touch source, tests, and generated"]);

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
					expect(output).toContain("file-kinds: source=2; docs=0; test=1; generated=1");
					expect(output).toContain("dirs=dist, src, test");
					expect(output).toContain("src/a.ts (+1/-1, source)");
				}),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("program rejects invalid LOCAL_RUNNER_CPU / MEMORY env values", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-invalid-runner-env-");
		const output = join(dir, "github_output");
		await withPatchedEnv(
			{
				GITHUB_WORKSPACE: dir,
				DEFAULT_BRANCH: "main",
				AUTO_PR_AI_PROVIDER: "local",
				GITHUB_OUTPUT: output,
				COMMITS_COUNT: "1",
				LOCAL_RUNNER_CPUS: "0",
				LOCAL_RUNNER_MEMORY_GB: "bad",
			},
			async () => {
				const error = await Effect.runPromise(program.pipe(Effect.flip));
				expect(error).toBeInstanceOf(RoutingContextParseError);
				expect(error).toMatchObject({
					_tag: "RoutingContextParseError",
					name: "LOCAL_RUNNER_CPUS",
					requirement: "a positive number",
					value: "0",
				});
			},
		);
	});

	test("program rejects invalid LOCAL_RUNNER_MEMORY_GB value", async () => {
		const dir = tempRepo("auto-pr-build-model-routing-context-invalid-memory-env-");
		const output = join(dir, "github_output");
		await withPatchedEnv(
			{
				GITHUB_WORKSPACE: dir,
				DEFAULT_BRANCH: "main",
				AUTO_PR_AI_PROVIDER: "local",
				GITHUB_OUTPUT: output,
				COMMITS_COUNT: "1",
				LOCAL_RUNNER_CPUS: "2",
				LOCAL_RUNNER_MEMORY_GB: "0",
			},
			async () => {
				const error = await Effect.runPromise(program.pipe(Effect.flip));
				expect(error).toBeInstanceOf(RoutingContextParseError);
				expect(error).toMatchObject({
					_tag: "RoutingContextParseError",
					name: "LOCAL_RUNNER_MEMORY_GB",
					requirement: "a positive number",
					value: "0",
				});
			},
		);
	});

	test("reportProgramError writes message and marks process as failed", () => {
		const originalWrite = process.stderr.write.bind(process.stderr);
		const originalExitCode = process.exitCode;
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			reportProgramError(new Error("boom"));
			reportProgramError("plain failure");
			expect(chunks.join("")).toContain("boom");
			expect(chunks.join("")).toContain("plain failure");
			expect(process.exitCode).toBe(1);
		} finally {
			process.stderr.write = originalWrite as typeof process.stderr.write;
			process.exitCode = originalExitCode ?? 0;
		}
	});
});
