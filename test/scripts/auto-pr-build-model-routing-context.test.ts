import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Result } from "effect";
import { runEffect } from "#test/run-effect.js";
import type { OpenRouterModelsRepositoryService } from "../../src/auto-pr/interfaces/openrouter-models-repository.js";
import { OpenRouterModelsRepository } from "../../src/auto-pr/live/openrouter-models-repository.js";
import {
  type OpenRouterModelCatalogEntry,
  parseOpenRouterModelCatalog,
} from "../../src/core/openrouter-routing.js";
import {
  makeProgram,
  program,
  runBuildModelRoutingContext,
} from "../../src/workflow/auto-pr-build-model-routing-context.js";

// When this test runs from lefthook's pre-push hook, git has GIT_DIR / GIT_WORK_TREE /
// GIT_INDEX_FILE etc. exported pointing at the REAL repo. If those leak into the fixture git
// commands below (which build throwaway repos under a tmpdir), the fixtures init/commit against
// the real repo instead of their temp dir, corrupting the real HEAD/index mid-commit. Strip them
// from every subprocess env this file spawns so git always resolves purely from `cwd`. Harmless
// when run standalone (the vars are simply absent from `process.env` already).
const GIT_ENV_LEAK_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
] as const;

for (const key of Object.keys(process.env).filter((key) => key.startsWith("GIT_"))) {
  delete process.env[key];
}

function sanitizedEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const key of GIT_ENV_LEAK_KEYS) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runGit(cwd: string, args: readonly string[]): Effect.Effect<void, Error> {
  return Effect.try({
    try: () => {
      const result = spawnSync("git", [...args], { cwd, encoding: "utf8", env: sanitizedEnv() });
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

// ─── OpenRouter catalog fixtures ─────────────────────────────────────────────

const OPENROUTER_GPT_OSS_20B_FREE_WIRE = {
  id: "openai/gpt-oss-20b:free",
  name: "OpenAI: gpt-oss-20b (free)",
  context_length: 131_072,
  supported_parameters: ["tools", "tool_choice"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
} as const;

const OPENROUTER_TEXT_ONLY_FREE_WIRE = {
  id: "vendor/text-only:free",
  name: "Vendor: Text Only (free)",
  context_length: 32_768,
  supported_parameters: [],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
} as const;

const OPENROUTER_TOOL_CAPABLE_FREE_WIRE = {
  id: "vendor/tool-capable:free",
  name: "Vendor: Tool Capable (free)",
  context_length: 65_536,
  supported_parameters: ["tools", "tool_choice"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
} as const;

const OPENROUTER_PAID_MODEL_WIRE = {
  id: "vendor/paid-model",
  name: "Vendor: Paid Model",
  context_length: 200_000,
  supported_parameters: ["tools", "tool_choice"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.000001", completion: "0.000002" },
} as const;

function openRouterCatalog(
  wireEntries: readonly unknown[],
): readonly OpenRouterModelCatalogEntry[] {
  return parseOpenRouterModelCatalog({ data: wireEntries });
}

function openRouterRepositoryLayer(
  entries: readonly OpenRouterModelCatalogEntry[],
): Layer.Layer<OpenRouterModelsRepositoryService> {
  return Layer.succeed(OpenRouterModelsRepository, {
    fetchModels: () => Effect.succeed(entries),
  });
}

const unusedOpenRouterRepositoryLayer = openRouterRepositoryLayer([]);

function readRoutingDecision(output: string): Record<string, unknown> {
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("routing_decision_json="));
  if (line === undefined) throw new Error("routing_decision_json output missing");
  return JSON.parse(line.slice("routing_decision_json=".length)) as Record<string, unknown>;
}

type EnvSnapshot = ReadonlyMap<string, string | undefined>;

function snapshotEnv(names: readonly string[]): EnvSnapshot {
  return new Map(names.map((name) => [name, process.env[name]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [name, value] of snapshot) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

const ROUTING_ENV_NAMES = [
  "AUTO_PR_AI_PROVIDER",
  "AUTO_PR_AI_LLAMACPP_MODEL_URL",
  "AUTO_PR_AI_OPENAI_COMPAT_URL",
  "AUTO_PR_LOCAL_MODEL",
  "AUTO_PR_OPENROUTER_MODEL",
  "AUTO_PR_OPENROUTER_TITLE",
  "COMMITS_COUNT",
  "DEFAULT_BRANCH",
  "GITHUB_OUTPUT",
  "GITHUB_WORKSPACE",
  "LOCAL_RUNNER_CPUS",
  "LOCAL_RUNNER_MEMORY_GB",
  "OPENROUTER_API_KEY",
  "REPOSITORY_VISIBILITY",
  "RUNNER_LABEL",
] as const;

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
    const generateReusableWorkflow = readFileSync(
      join(process.cwd(), ".github/workflows/auto-pr-generate-reusable.yml"),
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
    expect(runCommandAction).toContain("cloud_model_envelope_source:");
    expect(runCommandAction).toContain("openrouter_model_context_length:");
    expect(runCommandAction).not.toContain("github_models_plan_class");
    expect(runCommandAction).not.toContain("github_models_rate_limit_tier");
    expect(runCommandAction).not.toContain("github_models_envelope_source");
    expect(runCommandScript).toContain("build-model-routing-context)");
    expect(runCommandScript).toContain('BIN="auto-pr-build-model-routing-context"');
    expect(runCommandScript).toContain('SCRIPT="build-model-routing-context"');
    expect(generateReusableWorkflow).toContain(
      "AUTO_PR_ROUTING_DECISION_JSON: $" + "{{ steps.ai_routing.outputs.routing_decision_json }}",
    );
    expect(generateReusableWorkflow).toContain(
      "AUTO_PR_ROUTING_CONTEXT_JSON: $" + "{{ steps.ai_routing.outputs.routing_context_json }}",
    );
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
          env: sanitizedEnv({
            AUTO_PR_AI_PROVIDER: "local",
            AUTO_PR_LOCAL_MODEL: "",
            AUTO_PR_AI_OPENAI_COMPAT_URL: "",
            AUTO_PR_AI_LLAMACPP_MODEL_URL: "",
            AUTO_PR_PKG: "github:knirski/auto-pr",
            COMMITS_COUNT: "1",
            DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: githubOutput,
            GITHUB_WORKSPACE: dir,
            REPOSITORY_VISIBILITY: "private",
            RUNNER: "bunx",
            RUNNER_LABEL: "ubuntu-24.04",
            USE_WORKSPACE: "true",
          }),
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
          env: sanitizedEnv({
            AUTO_PR_AI_PROVIDER: "local",
            AUTO_PR_LOCAL_MODEL: "",
            AUTO_PR_AI_OPENAI_COMPAT_URL: "",
            AUTO_PR_AI_LLAMACPP_MODEL_URL: "",
            COMMITS_COUNT: "1",
            DEFAULT_BRANCH: "main",
            GITHUB_OUTPUT: githubOutput,
            GITHUB_WORKSPACE: dir,
            REPOSITORY_VISIBILITY: "private",
            RUNNER_LABEL: "ubuntu-24.04",
          }),
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
      await runEffect(unusedOpenRouterRepositoryLayer)(
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
      await runEffect(unusedOpenRouterRepositoryLayer)(
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

  test("classifies source maps under dist as generated files", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-generated-");
    try {
      await runEffect(unusedOpenRouterRepositoryLayer)(
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
          yield* Effect.sync(() => mkdirSync(join(dir, "dist"), { recursive: true }));
          yield* write(join(dir, "dist", "bundle.js.map"), "{}\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "chore: add map"]);

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
            "file-kinds: source=0; docs=0; test=0; generated=1; lockfiles=0; package-manifests=0",
          );
          expect(output).toContain("review_focus: dist/bundle.js.map (+1/-0, generated)");
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails with a clear error when DEFAULT_BRANCH ref does not exist", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-bad-base-");
    try {
      await runEffect(unusedOpenRouterRepositoryLayer)(
        Effect.gen(function* () {
          yield* runGit(dir, ["init", "-b", "main"]);
          yield* runGit(dir, ["config", "user.email", "test@example.com"]);
          yield* runGit(dir, ["config", "user.name", "Test User"]);
          yield* write(join(dir, "README.md"), "base\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "feat: base"]);

          const githubOutput = join(dir, "github_output");
          const exit = yield* runBuildModelRoutingContext({
            workspace: dir,
            defaultBranch: "does-not-exist",
            provider: "local",
            explicitModel: undefined,
            githubOutput,
            commitsCount: 1,
          }).pipe(Effect.exit);

          expect(exit._tag).toBe("Failure");
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program validates optional runner cpu env value", async () => {
    const original = {
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      DEFAULT_BRANCH: process.env.DEFAULT_BRANCH,
      AUTO_PR_AI_PROVIDER: process.env.AUTO_PR_AI_PROVIDER,
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      COMMITS_COUNT: process.env.COMMITS_COUNT,
      LOCAL_RUNNER_CPUS: process.env.LOCAL_RUNNER_CPUS,
      LOCAL_RUNNER_MEMORY_GB: process.env.LOCAL_RUNNER_MEMORY_GB,
    };
    const dir = tempRepo("auto-pr-build-model-routing-context-env-");
    const githubOutput = join(dir, "github_output");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runGit(dir, ["init", "-b", "main"]);
          yield* runGit(dir, ["config", "user.email", "test@example.com"]);
          yield* runGit(dir, ["config", "user.name", "Test User"]);
          yield* write(join(dir, "README.md"), "base\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "feat: base"]);
          yield* runGit(dir, ["branch", "origin/main"]);

          process.env.GITHUB_WORKSPACE = dir;
          process.env.DEFAULT_BRANCH = "main";
          process.env.AUTO_PR_AI_PROVIDER = "local";
          process.env.GITHUB_OUTPUT = githubOutput;
          process.env.COMMITS_COUNT = "1";
          process.env.LOCAL_RUNNER_CPUS = "abc";
          process.env.LOCAL_RUNNER_MEMORY_GB = "";

          const exit = yield* program.pipe(Effect.exit);
          expect(exit._tag).toBe("Failure");
        }),
      );
    } finally {
      process.env.GITHUB_WORKSPACE = original.GITHUB_WORKSPACE;
      process.env.DEFAULT_BRANCH = original.DEFAULT_BRANCH;
      process.env.AUTO_PR_AI_PROVIDER = original.AUTO_PR_AI_PROVIDER;
      process.env.GITHUB_OUTPUT = original.GITHUB_OUTPUT;
      process.env.COMMITS_COUNT = original.COMMITS_COUNT;
      process.env.LOCAL_RUNNER_CPUS = original.LOCAL_RUNNER_CPUS;
      process.env.LOCAL_RUNNER_MEMORY_GB = original.LOCAL_RUNNER_MEMORY_GB;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program validates optional commits count env value", async () => {
    const original = {
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      DEFAULT_BRANCH: process.env.DEFAULT_BRANCH,
      AUTO_PR_AI_PROVIDER: process.env.AUTO_PR_AI_PROVIDER,
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      COMMITS_COUNT: process.env.COMMITS_COUNT,
      LOCAL_RUNNER_CPUS: process.env.LOCAL_RUNNER_CPUS,
      LOCAL_RUNNER_MEMORY_GB: process.env.LOCAL_RUNNER_MEMORY_GB,
    };
    const dir = tempRepo("auto-pr-build-model-routing-context-commits-count-");
    const githubOutput = join(dir, "github_output");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runGit(dir, ["init", "-b", "main"]);
          yield* runGit(dir, ["config", "user.email", "test@example.com"]);
          yield* runGit(dir, ["config", "user.name", "Test User"]);
          yield* write(join(dir, "README.md"), "base\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "feat: base"]);
          yield* runGit(dir, ["branch", "origin/main"]);

          process.env.GITHUB_WORKSPACE = dir;
          process.env.DEFAULT_BRANCH = "main";
          process.env.AUTO_PR_AI_PROVIDER = "local";
          process.env.GITHUB_OUTPUT = githubOutput;
          process.env.COMMITS_COUNT = "abc";
          process.env.LOCAL_RUNNER_CPUS = "";
          process.env.LOCAL_RUNNER_MEMORY_GB = "";

          const exit = yield* program.pipe(Effect.exit);
          expect(exit._tag).toBe("Failure");
        }),
      );
    } finally {
      process.env.GITHUB_WORKSPACE = original.GITHUB_WORKSPACE;
      process.env.DEFAULT_BRANCH = original.DEFAULT_BRANCH;
      process.env.AUTO_PR_AI_PROVIDER = original.AUTO_PR_AI_PROVIDER;
      process.env.GITHUB_OUTPUT = original.GITHUB_OUTPUT;
      process.env.COMMITS_COUNT = original.COMMITS_COUNT;
      process.env.LOCAL_RUNNER_CPUS = original.LOCAL_RUNNER_CPUS;
      process.env.LOCAL_RUNNER_MEMORY_GB = original.LOCAL_RUNNER_MEMORY_GB;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program validates optional runner memory env value", async () => {
    const original = {
      GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE,
      DEFAULT_BRANCH: process.env.DEFAULT_BRANCH,
      AUTO_PR_AI_PROVIDER: process.env.AUTO_PR_AI_PROVIDER,
      GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
      COMMITS_COUNT: process.env.COMMITS_COUNT,
      LOCAL_RUNNER_CPUS: process.env.LOCAL_RUNNER_CPUS,
      LOCAL_RUNNER_MEMORY_GB: process.env.LOCAL_RUNNER_MEMORY_GB,
    };
    const dir = tempRepo("auto-pr-build-model-routing-context-mem-");
    const githubOutput = join(dir, "github_output");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* runGit(dir, ["init", "-b", "main"]);
          yield* runGit(dir, ["config", "user.email", "test@example.com"]);
          yield* runGit(dir, ["config", "user.name", "Test User"]);
          yield* write(join(dir, "README.md"), "base\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "feat: base"]);
          yield* runGit(dir, ["branch", "origin/main"]);

          process.env.GITHUB_WORKSPACE = dir;
          process.env.DEFAULT_BRANCH = "main";
          process.env.AUTO_PR_AI_PROVIDER = "local";
          process.env.GITHUB_OUTPUT = githubOutput;
          process.env.COMMITS_COUNT = "1";
          process.env.LOCAL_RUNNER_CPUS = "2";
          process.env.LOCAL_RUNNER_MEMORY_GB = "0";

          const exit = yield* program.pipe(Effect.exit);
          expect(exit._tag).toBe("Failure");
        }),
      );
    } finally {
      process.env.GITHUB_WORKSPACE = original.GITHUB_WORKSPACE;
      process.env.DEFAULT_BRANCH = original.DEFAULT_BRANCH;
      process.env.AUTO_PR_AI_PROVIDER = original.AUTO_PR_AI_PROVIDER;
      process.env.GITHUB_OUTPUT = original.GITHUB_OUTPUT;
      process.env.COMMITS_COUNT = original.COMMITS_COUNT;
      process.env.LOCAL_RUNNER_CPUS = original.LOCAL_RUNNER_CPUS;
      process.env.LOCAL_RUNNER_MEMORY_GB = original.LOCAL_RUNNER_MEMORY_GB;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program fails when required env is missing", async () => {
    const originalDefaultBranch = process.env.DEFAULT_BRANCH;
    try {
      process.env.DEFAULT_BRANCH = "";
      const exit = await Effect.runPromise(program.pipe(Effect.exit));
      expect(exit._tag).toBe("Failure");
    } finally {
      process.env.DEFAULT_BRANCH = originalDefaultBranch;
    }
  });

  test("emits a default model and signal summary for single-commit PRs", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-");
    try {
      await runEffect(unusedOpenRouterRepositoryLayer)(
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
      await runEffect(unusedOpenRouterRepositoryLayer)(
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
            provider: "openrouter",
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

  test("ignores explicit model override for openrouter", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-override-");
    try {
      await runEffect(
        openRouterRepositoryLayer(openRouterCatalog([OPENROUTER_GPT_OSS_20B_FREE_WIRE])),
      )(
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
            provider: "openrouter",
            explicitModel: "openai/gpt-4.1",
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
          expect(output).not.toContain("openai/gpt-4.1");
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("selects a feasible OpenRouter catalog model and emits OpenRouter outputs", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-catalog-");
    try {
      await runEffect(
        openRouterRepositoryLayer(openRouterCatalog([OPENROUTER_GPT_OSS_20B_FREE_WIRE])),
      )(
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
            provider: "openrouter",
            explicitModel: undefined,
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
          expect(output).toContain("provider=openrouter");
          expect(output).toContain("requires_tool_calls=false");
          expect(output).toContain("cloud_model_envelope_source=catalog");
          expect(output).toContain("openrouter_model_context_length=131072");
          expect(output).not.toContain("github_models_plan_class");
          expect(output).not.toContain("github_models_rate_limit_tier");
          expect(output).not.toContain("github_models_envelope_source");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "openai/gpt-oss-20b:free",
            requiresToolCalls: false,
            band: "A",
            selectionMode: "catalog",
          });
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("prefers a tool-capable free catalog model for tool routes", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-tools-");
    try {
      await runEffect(
        openRouterRepositoryLayer(
          openRouterCatalog([OPENROUTER_TEXT_ONLY_FREE_WIRE, OPENROUTER_TOOL_CAPABLE_FREE_WIRE]),
        ),
      )(
        Effect.gen(function* () {
          yield* runGit(dir, ["init", "-b", "main"]);
          yield* runGit(dir, ["config", "user.email", "test@example.com"]);
          yield* runGit(dir, ["config", "user.name", "Test User"]);

          yield* write(join(dir, "base.txt"), "base\n");
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "docs: base"]);
          yield* runGit(dir, ["branch", "origin/main"]);
          yield* runGit(dir, ["checkout", "-b", "feature"]);

          yield* Effect.sync(() => mkdirSync(join(dir, "src"), { recursive: true }));
          const sourceLines = (count: number): string =>
            `${Array.from({ length: count }, (_, i) => `export const value${i} = ${i};`).join("\n")}\n`;
          yield* write(join(dir, "src", "a.ts"), sourceLines(120));
          yield* write(join(dir, "src", "b.ts"), sourceLines(100));
          yield* write(join(dir, "src", "c.ts"), sourceLines(80));
          yield* runGit(dir, ["add", "."]);
          yield* runGit(dir, ["commit", "-m", "feat: add modules"]);

          const githubOutput = join(dir, "github_output");
          yield* runBuildModelRoutingContext({
            workspace: dir,
            defaultBranch: "main",
            provider: "openrouter",
            explicitModel: undefined,
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("band=B");
          expect(output).toContain("requires_tool_calls=true");
          expect(output).toContain("selected_model=vendor/tool-capable:free");
          expect(output).toContain("cloud_model_envelope_source=catalog");
          expect(output).toContain("openrouter_model_context_length=65536");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "vendor/tool-capable:free",
            requiresToolCalls: true,
            band: "B",
            selectionMode: "free-tool-fallback",
          });
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the static free model when the catalog has no usable models", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-outage-");
    try {
      await runEffect(openRouterRepositoryLayer(openRouterCatalog([OPENROUTER_PAID_MODEL_WIRE])))(
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
            provider: "openrouter",
            explicitModel: undefined,
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("provider=openrouter");
          expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
          expect(output).toContain("cloud_model_envelope_source=static-fallback");
          expect(output).toContain("openrouter_model_context_length=8000");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "openai/gpt-oss-20b:free",
            requiresToolCalls: false,
            selectionMode: "static-fallback",
          });
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves a configured free model when the catalog is unavailable", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-configured-");
    try {
      await runEffect(openRouterRepositoryLayer(openRouterCatalog([OPENROUTER_PAID_MODEL_WIRE])))(
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
            provider: "openrouter",
            explicitModel: undefined,
            openRouterModel: "openrouter/free",
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("selected_model=openrouter/free");
          expect(output).toContain("cloud_model_envelope_source=configured");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "openrouter/free",
            selectionMode: "configured",
          });
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps a catalog-feasible configured model as preferred", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-preferred-");
    try {
      await runEffect(
        openRouterRepositoryLayer(openRouterCatalog([OPENROUTER_GPT_OSS_20B_FREE_WIRE])),
      )(
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
            provider: "openrouter",
            explicitModel: undefined,
            openRouterModel: "openai/gpt-oss-20b:free",
            githubOutput,
            commitsCount: 1,
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
          expect(output).toContain("cloud_model_envelope_source=catalog");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "openai/gpt-oss-20b:free",
            selectionMode: "preferred",
          });
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("classifies dependency manifests separately from generated files", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-deps-");
    try {
      await runEffect(unusedOpenRouterRepositoryLayer)(
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
            provider: "openrouter",
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

  test("program rejects the retired github-models provider", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-retired-");
    const envSnapshot = snapshotEnv(ROUTING_ENV_NAMES);
    try {
      process.env.GITHUB_WORKSPACE = dir;
      process.env.DEFAULT_BRANCH = "main";
      process.env.AUTO_PR_AI_PROVIDER = "github-models";
      process.env.GITHUB_OUTPUT = join(dir, "github_output");

      const exit = await Effect.runPromise(program.pipe(Effect.exit));

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        Result.match(Cause.findError(exit.cause), {
          onSuccess: (error) =>
            expect(error instanceof Error ? error.message : String(error)).toContain(
              "Invalid AUTO_PR_AI_PROVIDER: github-models. GitHub Models was retired on 2026-07-30; use openrouter or local.",
            ),
          onFailure: () => expect().fail("expected provider validation error"),
        });
      }
    } finally {
      restoreEnv(envSnapshot);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program routes openrouter through the injected repository layer", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-openrouter-program-");
    const envSnapshot = snapshotEnv(ROUTING_ENV_NAMES);
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
          process.env.GITHUB_WORKSPACE = dir;
          process.env.DEFAULT_BRANCH = "main";
          process.env.AUTO_PR_AI_PROVIDER = "openrouter";
          process.env.AUTO_PR_OPENROUTER_MODEL = "openai/gpt-oss-20b:free";
          process.env.AUTO_PR_OPENROUTER_TITLE = "";
          process.env.OPENROUTER_API_KEY = "";
          process.env.GITHUB_OUTPUT = githubOutput;
          process.env.COMMITS_COUNT = "1";
          process.env.LOCAL_RUNNER_CPUS = "";
          process.env.LOCAL_RUNNER_MEMORY_GB = "";
          process.env.REPOSITORY_VISIBILITY = "private";
          process.env.RUNNER_LABEL = "ubuntu-24.04";

          yield* makeProgram({
            openRouterRepositoryLayer: openRouterRepositoryLayer(
              openRouterCatalog([OPENROUTER_GPT_OSS_20B_FREE_WIRE]),
            ),
          });

          const output = yield* read(githubOutput);
          expect(output).toContain("provider=openrouter");
          expect(output).toContain("selected_model=openai/gpt-oss-20b:free");
          expect(output).toContain("cloud_model_envelope_source=catalog");
          expect(output).toContain("openrouter_model_context_length=131072");
          expect(readRoutingDecision(output)).toMatchObject({
            provider: "openrouter",
            selectedModel: "openai/gpt-oss-20b:free",
            selectionMode: "preferred",
          });
        }),
      );
    } finally {
      restoreEnv(envSnapshot);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("program reads required env vars and emits routing outputs", async () => {
    const dir = tempRepo("auto-pr-build-model-routing-context-program-");
    const originalEnv = {
      AUTO_PR_AI_LLAMACPP_MODEL_URL: process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL,
      AUTO_PR_LOCAL_MODEL: process.env.AUTO_PR_LOCAL_MODEL,
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
          process.env.AUTO_PR_LOCAL_MODEL = "";
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
      process.env.AUTO_PR_LOCAL_MODEL = originalEnv.AUTO_PR_LOCAL_MODEL;
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
