import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Effect, Layer, Redacted } from "effect";
import type { OpenRouterModelsRepositoryService } from "#auto-pr/interfaces/openrouter-models-repository.js";
import {
  makeOpenRouterModelsRepositoryLive,
  OpenRouterModelsRepository,
} from "#auto-pr/live/openrouter-models-repository.js";
import { cleanGitEnv } from "#auto-pr/shell.js";
import {
  type BuildDetailedRoutingContextInput,
  buildDetailedRoutingContext,
  type LocalModelContext,
  type ModelBandDecision,
  type ModelBandSignals,
  type ModelProvider,
  parseCommitLog,
  type RoutingContextCommitSummary,
  type RoutingContextFileSummary,
  type RoutingContextHotspot,
  resolveLocalRunnerResources,
  resolveModelBand,
} from "../core/model-routing.js";
import {
  buildOpenRouterRequestEnvelope,
  type CloudModelRequestEnvelope,
  DEFAULT_OPENROUTER_TITLE,
  type OpenRouterModelCatalogEntry,
  type OpenRouterModelSelection,
  pickOpenRouterModelCatalogEntry,
} from "../core/openrouter-routing.js";
import type { RoutingContextArtifact } from "../core/routing-artifacts.js";

type RoutingContextInputs = {
  readonly workspace: string;
  readonly defaultBranch: string;
  readonly provider: ModelProvider;
  readonly explicitModel: string | undefined;
  readonly openRouterModel?: string;
  readonly openaiCompatUrl?: string;
  readonly llamacppModelUrl?: string;
  readonly runnerLabel?: string;
  readonly repositoryVisibility?: string;
  readonly localRunnerCpus?: number;
  readonly localRunnerMemoryGb?: number;
  readonly githubOutput: string;
  readonly commitsCount: number | undefined;
};

type GitResult = {
  readonly stdout: string;
  readonly stderr: string;
};

type ParsedCommit = {
  readonly type: string | undefined;
  readonly breaking: boolean;
};

type RoutingContextSignalInput = Pick<
  BuildDetailedRoutingContextInput,
  "signals" | "commits" | "files"
>;

type RoutingEnvelopeOutput = {
  readonly tokenBudget: number;
  readonly toolRoundLimit: number;
  readonly toolResponseCharBudget: number;
  readonly cloudModelEnvelopeSource: CloudModelRequestEnvelope["source"];
  readonly selectionMode: string;
  readonly openRouterModelContextLength?: number;
};

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function readRequiredEnv(name: string): Effect.Effect<string, Error> {
  return Effect.try({
    try: () => {
      const value = process.env[name]?.trim();
      if (value === undefined || value === "") {
        throw new Error(`${name} is required`);
      }
      return value;
    },
    catch: toError,
  });
}

function parseProvider(raw: string): Effect.Effect<ModelProvider, Error> {
  return Effect.try({
    try: () => {
      const provider = raw.trim().toLowerCase();
      if (provider === "local" || provider === "openrouter") return provider;
      if (provider === "github-models") {
        throw new Error(
          "Invalid AUTO_PR_AI_PROVIDER: github-models. GitHub Models was retired on 2026-07-30; use openrouter or local.",
        );
      }
      throw new Error(`Invalid AUTO_PR_AI_PROVIDER: ${raw}. Must be local or openrouter`);
    },
    catch: toError,
  });
}

function parseOptionalPositiveInteger(
  raw: string,
  name: string,
): Effect.Effect<number | undefined, Error> {
  return Effect.try({
    try: () => {
      const trimmed = raw.trim();
      if (trimmed === "") return undefined;
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer, got ${raw}`);
      }
      return value;
    },
    catch: toError,
  });
}

function parseOptionalPositiveNumber(
  raw: string,
  name: string,
): Effect.Effect<number | undefined, Error> {
  return Effect.try({
    try: () => {
      const trimmed = raw.trim();
      if (trimmed === "") return undefined;
      const value = Number(trimmed);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive number, got ${raw}`);
      }
      return value;
    },
    catch: toError,
  });
}

function runGit(workspace: string, args: readonly string[]): Effect.Effect<GitResult, Error> {
  return Effect.try({
    try: () => {
      const result = spawnSync("git", [...args], {
        cwd: workspace,
        encoding: "utf8",
        env: cleanGitEnv(),
        timeout: 30_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
    catch: toError,
  });
}

function estimatePromptChars(signals: ModelBandSignals): number {
  const base = 7_500;
  return base + signals.changedFileCount * 120 + signals.semanticCommitCount * 180;
}

// ─── OpenRouter envelope ─────────────────────────────────────────────────────

const unusedOpenRouterModelsRepositoryLayer: Layer.Layer<OpenRouterModelsRepositoryService> =
  Layer.succeed(OpenRouterModelsRepository, {
    fetchModels: (): Effect.Effect<readonly OpenRouterModelCatalogEntry[], never, never> =>
      Effect.succeed([]),
  });

function resolveEnvelopeSource(
  selection: OpenRouterModelSelection,
): CloudModelRequestEnvelope["source"] {
  if (selection.catalogEntry !== undefined) return "catalog";
  if (selection.selectionMode === "configured") return "configured";
  return "static-fallback";
}

function buildOpenRouterEnvelope(input: {
  readonly decision: ModelBandDecision;
  readonly signals: ModelBandSignals;
  readonly configuredModel?: string;
  readonly entries: readonly OpenRouterModelCatalogEntry[];
}): {
  readonly envelope: CloudModelRequestEnvelope;
  readonly selection: OpenRouterModelSelection;
} {
  const selection = pickOpenRouterModelCatalogEntry({
    band: input.decision.band,
    ...(input.configuredModel === undefined ? {} : { configuredModel: input.configuredModel }),
    entries: input.entries,
    requiresToolCalls: input.decision.requiresToolCalls,
  });
  const envelope = buildOpenRouterRequestEnvelope({
    model: selection.model,
    requested: {
      promptChars: estimatePromptChars(input.signals),
      commitCount: input.signals.semanticCommitCount,
      changedFileCount: input.signals.changedFileCount,
      sourceChurn: input.signals.sourceChurn,
      toolStrategy: input.decision.toolStrategy,
      reasoningNeed: input.decision.reasoningNeed,
    },
    ...(selection.catalogEntry === undefined ? {} : { catalogEntry: selection.catalogEntry }),
    source: resolveEnvelopeSource(selection),
  });
  return { envelope, selection };
}

function defaultEnvelopeForLocal(): RoutingEnvelopeOutput {
  return {
    tokenBudget: 12_000,
    toolRoundLimit: 6,
    toolResponseCharBudget: 8_000,
    cloudModelEnvelopeSource: "static-fallback",
    selectionMode: "static-fallback",
  };
}

function classifyFile(
  path: string,
): "source" | "docs" | "test" | "generated" | "lockfile" | "package" | "other" {
  if (
    /^(package-lock\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|flake\.lock)$/.test(
      path,
    )
  ) {
    return "lockfile";
  }
  if (/^(package\.json|bun\.config\.[^/]+|flake\.nix)$/.test(path)) return "package";
  if (
    /(^|\/)(dist|build|out|coverage|vendor|__snapshots__|\.terraform)(\/|$)/.test(path) ||
    /(^|\/)\.next(\/|$)/.test(path) ||
    /\.min\.js$/.test(path) ||
    /\.map$/.test(path)
  ) {
    return "generated";
  }
  if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(path) || /\.(test|spec)\.[^/]+$/.test(path))
    return "test";
  if (path.startsWith("docs/") || path.endsWith(".md")) return "docs";
  if (/^src\//.test(path)) return "source";
  return "other";
}

function topLevelBucket(path: string): string {
  return path.includes("/") ? (path.split("/", 1)[0] ?? "<root>") : "<root>";
}

function buildCommitSummary(
  commits: readonly ParsedCommit[],
  mergeCommitCount: number,
): RoutingContextCommitSummary {
  const typeCounts: Record<string, number> = Object.create(null);
  let breakingCommitCount = 0;
  for (const commit of commits) {
    if (commit.breaking) breakingCommitCount++;
    const type = commit.type?.trim().toLowerCase();
    if (type) {
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }
  }
  return {
    semanticCommitCount: commits.length,
    mergeCommitCount,
    breakingCommitCount,
    typeCounts,
  };
}

function sortHotspots(items: RoutingContextHotspot[]): RoutingContextHotspot[] {
  return items.sort((a, b) => {
    if (b.churn !== a.churn) return b.churn - a.churn;
    return a.path.localeCompare(b.path);
  });
}

function buildFileSummary(input: {
  readonly files: readonly string[];
  readonly numstat: readonly string[];
  readonly nameStatus: readonly string[];
}): RoutingContextFileSummary {
  const topLevelDirs = new Set<string>();
  const topDirChurn = new Map<string, RoutingContextHotspot>();
  const fileHotspots = new Map<string, RoutingContextHotspot>();

  let sourceFileCount = 0;
  let docsFileCount = 0;
  let testFileCount = 0;
  let generatedFileCount = 0;
  let lockfileCount = 0;
  let packageManifestCount = 0;
  let rawChurn = 0;
  let sourceChurn = 0;
  let generatedChurn = 0;
  let hasBinaryFiles = false;
  let addedFileCount = 0;
  let modifiedFileCount = 0;
  let deletedFileCount = 0;
  let renamedFileCount = 0;

  for (const file of input.files) {
    const top = topLevelBucket(file);
    topLevelDirs.add(top);
    switch (classifyFile(file)) {
      case "source":
        sourceFileCount++;
        break;
      case "docs":
        docsFileCount++;
        break;
      case "test":
        testFileCount++;
        break;
      case "generated":
        generatedFileCount++;
        break;
      case "lockfile":
        lockfileCount++;
        break;
      case "package":
        packageManifestCount++;
        break;
    }
  }

  for (const line of input.nameStatus) {
    const [statusRaw] = line.split(/\s+/);
    const status = statusRaw?.charAt(0) ?? "";
    if (status === "A") addedFileCount++;
    if (status === "M") modifiedFileCount++;
    if (status === "D") deletedFileCount++;
    if (status === "R") renamedFileCount++;
  }

  for (const line of input.numstat) {
    const [insRaw, delRaw, ...rest] = line.split(/\s+/);
    const path = rest.join(" ");
    if (!path) continue;
    const insertions = insRaw === "-" ? 0 : Number(insRaw);
    const deletions = delRaw === "-" ? 0 : Number(delRaw);
    if (insRaw === "-" || delRaw === "-") hasBinaryFiles = true;
    const churn = insertions + deletions;
    rawChurn += churn;
    const kind = classifyFile(path);
    if (kind === "generated") generatedChurn += churn;
    if (kind === "source") sourceChurn += churn;

    const fileEntry: RoutingContextHotspot = {
      path,
      churn,
      insertions,
      deletions,
      kind,
    };
    fileHotspots.set(path, fileEntry);

    const top = topLevelBucket(path);
    const dirEntry = topDirChurn.get(top);
    if (dirEntry === undefined) {
      topDirChurn.set(top, { ...fileEntry, path: top });
    } else {
      dirEntry.churn += churn;
      dirEntry.insertions += insertions;
      dirEntry.deletions += deletions;
    }
  }

  return {
    changedFiles: [...input.files],
    topLevelDirs: [...topLevelDirs].sort((a, b) => a.localeCompare(b)),
    topFiles: sortHotspots([...fileHotspots.values()]),
    topDirs: sortHotspots([...topDirChurn.values()]),
    sourceFileCount,
    docsFileCount,
    testFileCount,
    generatedFileCount,
    lockfileCount,
    packageManifestCount,
    rawChurn,
    sourceChurn,
    generatedChurn,
    hasBinaryFiles,
    addedFileCount,
    modifiedFileCount,
    deletedFileCount,
    renamedFileCount,
  };
}

const buildRoutingContextInput = Effect.fn("buildRoutingContextInput")(function* (
  input: RoutingContextInputs,
): Effect.fn.Return<RoutingContextSignalInput, Error, never> {
  const range = `origin/${input.defaultBranch}..HEAD`;
  const filesOutput = yield* runGit(input.workspace, ["diff", "--name-only", range]);
  const numstatOutput = yield* runGit(input.workspace, ["diff", "--numstat", range]);
  const nameStatusOutput = yield* runGit(input.workspace, ["diff", "--name-status", range]);
  const logOutput = yield* runGit(input.workspace, ["log", "--format=%H%n%B%x00", range]);

  const files = filesOutput.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const numstat = numstatOutput.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const nameStatus = nameStatusOutput.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const commits = parseCommitLog(logOutput.stdout);
  const semanticCommits = commits.filter((commit) => !commit.subject.startsWith("Merge "));
  const mergeCommitCount = commits.length - semanticCommits.length;
  const commitSummary = buildCommitSummary(
    semanticCommits.map((commit) => ({
      type: commit.type,
      breaking: commit.breaking,
    })),
    mergeCommitCount,
  );
  const fileSummary = buildFileSummary({ files, numstat, nameStatus });
  const semanticCommitCount = input.commitsCount ?? semanticCommits.length;
  const signals: ModelBandSignals = {
    semanticCommitCount,
    conventionalTypeCount: new Set(
      semanticCommits.map((commit) => commit.type?.toLowerCase() ?? "").filter(Boolean),
    ).size,
    topLevelSpread: fileSummary.topLevelDirs.length,
    changedFileCount: files.length,
    sourceFileCount: fileSummary.sourceFileCount,
    docsFileCount: fileSummary.docsFileCount,
    testFileCount: fileSummary.testFileCount,
    generatedFileCount: fileSummary.generatedFileCount,
    lockfileCount: fileSummary.lockfileCount,
    packageManifestCount: fileSummary.packageManifestCount,
    rawChurn: fileSummary.rawChurn,
    sourceChurn: fileSummary.sourceChurn,
    generatedChurn: fileSummary.generatedChurn,
    hasBreakingChange: semanticCommits.some((commit) => commit.breaking),
    hasBinaryFiles: fileSummary.hasBinaryFiles,
  };
  return {
    signals,
    commits: {
      ...commitSummary,
      semanticCommitCount,
    },
    files: fileSummary,
  };
});

function writeDecisionOutputs(
  githubOutput: string,
  provider: ModelProvider,
  decision: ModelBandDecision,
  routingContextArtifact: RoutingContextArtifact,
  envelope: RoutingEnvelopeOutput,
): Effect.Effect<void, Error> {
  const singleLine = (name: string, value: string): string => {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${name} must not contain newlines`);
    }
    return value;
  };
  return Effect.try({
    try: () => {
      appendFileSync(
        githubOutput,
        `selected_model=${singleLine("selected_model", decision.selectedModel)}\n`,
      );
      appendFileSync(githubOutput, `provider=${singleLine("provider", provider)}\n`);
      appendFileSync(
        githubOutput,
        `tool_strategy=${singleLine("tool_strategy", decision.toolStrategy)}\n`,
      );
      appendFileSync(
        githubOutput,
        `reasoning_need=${singleLine("reasoning_need", decision.reasoningNeed)}\n`,
      );
      appendFileSync(
        githubOutput,
        `requires_tool_calls=${decision.requiresToolCalls ? "true" : "false"}\n`,
      );
      const routingDecisionJson = JSON.stringify({
        provider,
        selectedModel: decision.selectedModel,
        requiresToolCalls: decision.requiresToolCalls,
        tokenBudget: envelope.tokenBudget,
        toolRoundLimit: envelope.toolRoundLimit,
        toolResponseCharBudget: envelope.toolResponseCharBudget,
        band: decision.band,
        selectionMode: envelope.selectionMode,
      });
      appendFileSync(githubOutput, `routing_decision_json=${routingDecisionJson}\n`);
      appendFileSync(
        githubOutput,
        `routing_context_json=${JSON.stringify(routingContextArtifact)}\n`,
      );
      if (decision.localRunnerResources !== undefined) {
        appendFileSync(
          githubOutput,
          `local_runner_resources=${singleLine("local_runner_resources", decision.localRunnerResources)}\n`,
        );
      }
      if (decision.localModelResourceFit !== undefined) {
        appendFileSync(
          githubOutput,
          `local_model_resource_fit=${singleLine("local_model_resource_fit", decision.localModelResourceFit)}\n`,
        );
      }
      if (decision.localModelRecommendation !== undefined) {
        appendFileSync(
          githubOutput,
          `local_model_recommendation=${singleLine("local_model_recommendation", decision.localModelRecommendation)}\n`,
        );
      }
      const delimiter = `__AUTO_PR_ROUTING_CONTEXT_${randomUUID()}__`;
      appendFileSync(
        githubOutput,
        `routing_context<<${delimiter}\n${decision.routingContext}\n${delimiter}\n`,
      );
      appendFileSync(githubOutput, `band=${decision.band}\n`);
      appendFileSync(githubOutput, `token_budget=${envelope.tokenBudget}\n`);
      appendFileSync(githubOutput, `tool_round_limit=${envelope.toolRoundLimit}\n`);
      appendFileSync(
        githubOutput,
        `tool_response_char_budget=${envelope.toolResponseCharBudget}\n`,
      );
      appendFileSync(
        githubOutput,
        `cloud_model_envelope_source=${singleLine("cloud_model_envelope_source", envelope.cloudModelEnvelopeSource)}\n`,
      );
      if (envelope.openRouterModelContextLength !== undefined) {
        appendFileSync(
          githubOutput,
          `openrouter_model_context_length=${envelope.openRouterModelContextLength}\n`,
        );
      }
    },
    catch: toError,
  });
}

export function runBuildModelRoutingContext(
  input: RoutingContextInputs,
): Effect.Effect<void, Error, OpenRouterModelsRepositoryService> {
  return Effect.gen(function* () {
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "start",
      workspace: input.workspace,
      default_branch: input.defaultBranch,
      provider: input.provider,
      explicit_model: input.explicitModel ?? "(none)",
    });
    const routingInput = yield* buildRoutingContextInput(input);
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "signals",
      status: "computed",
      signals: routingInput.signals,
      semantic_commits: routingInput.commits.semanticCommitCount,
      changed_files: routingInput.files.changedFiles.length,
      raw_churn: routingInput.files.rawChurn,
      source_churn: routingInput.files.sourceChurn,
    });
    const localModel: LocalModelContext | undefined =
      input.provider === "local"
        ? {
            ...(input.openaiCompatUrl === undefined
              ? {}
              : { openaiCompatUrl: input.openaiCompatUrl }),
            ...(input.llamacppModelUrl === undefined
              ? {}
              : { llamacppModelUrl: input.llamacppModelUrl }),
            runner: resolveLocalRunnerResources({
              ...(input.runnerLabel === undefined ? {} : { runnerLabel: input.runnerLabel }),
              ...(input.repositoryVisibility === undefined
                ? {}
                : { repositoryVisibility: input.repositoryVisibility }),
              ...(input.localRunnerCpus === undefined ? {} : { cpuCount: input.localRunnerCpus }),
              ...(input.localRunnerMemoryGb === undefined
                ? {}
                : { memoryGb: input.localRunnerMemoryGb }),
            }),
          }
        : undefined;
    let decision = resolveModelBand({
      provider: input.provider,
      signals: routingInput.signals,
      ...(input.explicitModel === undefined ? {} : { explicitModel: input.explicitModel }),
      ...(localModel === undefined ? {} : { localModel }),
    });
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "model_selection",
      status: "resolved",
      band: decision.band,
      selected_model: decision.selectedModel,
      tool_strategy: decision.toolStrategy,
      reasoning_need: decision.reasoningNeed,
      requires_tool_calls: decision.requiresToolCalls,
      local_runner_resources: decision.localRunnerResources ?? "(n/a)",
      local_model_resource_fit: decision.localModelResourceFit ?? "(n/a)",
      local_model_recommendation: decision.localModelRecommendation ?? "(n/a)",
    });
    const envelopeResolved =
      input.provider === "openrouter"
        ? yield* Effect.gen(function* () {
            const repository = yield* OpenRouterModelsRepository;
            const catalogEntries = yield* repository.fetchModels();
            const built = buildOpenRouterEnvelope({
              decision,
              signals: routingInput.signals,
              ...(input.openRouterModel === undefined
                ? {}
                : { configuredModel: input.openRouterModel }),
              entries: catalogEntries,
            });
            decision = {
              ...decision,
              selectedModel: built.selection.model,
              requiresToolCalls: built.selection.requiresToolCalls,
            };
            yield* Effect.log({
              event: "build_model_routing_context",
              step: "model_selection",
              status: "openrouter_catalog_resolved",
              selected_model: built.selection.model,
              requires_tool_calls: built.selection.requiresToolCalls,
              selection_mode: built.selection.selectionMode,
              envelope_source: built.envelope.source,
              context_length: built.envelope.contextLength,
              catalog_entries: catalogEntries.length,
            });
            return {
              tokenBudget: built.envelope.tokenBudget,
              toolRoundLimit: built.envelope.toolRoundLimit,
              toolResponseCharBudget: built.envelope.toolResponseCharBudget,
              cloudModelEnvelopeSource: built.envelope.source,
              selectionMode: built.selection.selectionMode,
              openRouterModelContextLength: built.envelope.contextLength,
            } satisfies RoutingEnvelopeOutput;
          })
        : defaultEnvelopeForLocal();
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "envelope",
      status: "resolved",
      provider: input.provider,
      token_budget: envelopeResolved.tokenBudget,
      tool_round_limit: envelopeResolved.toolRoundLimit,
      tool_response_char_budget: envelopeResolved.toolResponseCharBudget,
      cloud_model_envelope_source: envelopeResolved.cloudModelEnvelopeSource,
      selection_mode: envelopeResolved.selectionMode,
      openrouter_model_context_length: envelopeResolved.openRouterModelContextLength ?? "(n/a)",
    });
    const routingContext = buildDetailedRoutingContext({
      band: decision.band,
      selectedModel: decision.selectedModel,
      toolStrategy: decision.toolStrategy,
      reasoningNeed: decision.reasoningNeed,
      requiresToolCalls: decision.requiresToolCalls,
      signals: routingInput.signals,
      commits: routingInput.commits,
      files: routingInput.files,
      ...(decision.localRunnerResources === undefined
        ? {}
        : { localRunnerResources: decision.localRunnerResources }),
      ...(decision.localModelResourceFit === undefined
        ? {}
        : { localModelResourceFit: decision.localModelResourceFit }),
      ...(decision.localModelRecommendation === undefined
        ? {}
        : { localModelRecommendation: decision.localModelRecommendation }),
    });
    yield* writeDecisionOutputs(
      input.githubOutput,
      input.provider,
      {
        ...decision,
        routingContext,
      },
      {
        provider: input.provider,
        band: decision.band,
        selectedModel: decision.selectedModel,
        toolStrategy: decision.toolStrategy,
        reasoningNeed: decision.reasoningNeed,
        requiresToolCalls: decision.requiresToolCalls,
        signals: routingInput.signals,
        commits: routingInput.commits,
        files: routingInput.files,
        localRunnerResources: decision.localRunnerResources,
        localModelResourceFit: decision.localModelResourceFit,
        localModelRecommendation: decision.localModelRecommendation,
      },
      envelopeResolved,
    );
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "outputs",
      status: "written",
      github_output: input.githubOutput,
      provider: input.provider,
      selected_model: decision.selectedModel,
      band: decision.band,
      tool_strategy: decision.toolStrategy,
      token_budget: envelopeResolved.tokenBudget,
      tool_round_limit: envelopeResolved.toolRoundLimit,
      tool_response_char_budget: envelopeResolved.toolResponseCharBudget,
      routing_context_chars: routingContext.length,
    });
  });
}

export type BuildModelRoutingContextProgramOptions = {
  /** Test seam: inject a mock OpenRouter catalog repository instead of the live client. */
  readonly openRouterRepositoryLayer?: Layer.Layer<OpenRouterModelsRepositoryService>;
};

export const makeProgram = (options: BuildModelRoutingContextProgramOptions = {}) =>
  Effect.gen(function* () {
    const workspace = yield* readRequiredEnv("GITHUB_WORKSPACE");
    const defaultBranch = yield* readRequiredEnv("DEFAULT_BRANCH");
    const providerRaw = yield* readRequiredEnv("AUTO_PR_AI_PROVIDER");
    const githubOutput = yield* readRequiredEnv("GITHUB_OUTPUT");
    const explicitModelRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_LOCAL_MODEL?.trim() ?? "",
    );
    const openRouterModelRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_OPENROUTER_MODEL?.trim() ?? "",
    );
    const openRouterApiKeyRaw = yield* Effect.sync(
      () => process.env.OPENROUTER_API_KEY?.trim() ?? "",
    );
    const openRouterTitleRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_OPENROUTER_TITLE?.trim() ?? "",
    );
    const openRouterHttpRefererRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_OPENROUTER_HTTP_REFERER?.trim() ?? "",
    );
    const openaiCompatUrlRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_AI_OPENAI_COMPAT_URL?.trim() ?? "",
    );
    const llamacppModelUrlRaw = yield* Effect.sync(
      () => process.env.AUTO_PR_AI_LLAMACPP_MODEL_URL?.trim() ?? "",
    );
    const runnerLabelRaw = yield* Effect.sync(() => process.env.RUNNER_LABEL?.trim() ?? "");
    const repositoryVisibilityRaw = yield* Effect.sync(
      () => process.env.REPOSITORY_VISIBILITY?.trim() ?? "",
    );
    const localRunnerCpusRaw = yield* Effect.sync(
      () => process.env.LOCAL_RUNNER_CPUS?.trim() ?? "",
    );
    const localRunnerMemoryGbRaw = yield* Effect.sync(
      () => process.env.LOCAL_RUNNER_MEMORY_GB?.trim() ?? "",
    );
    const commitsCountRaw = yield* Effect.sync(() => process.env.COMMITS_COUNT?.trim() ?? "");
    const provider = yield* parseProvider(providerRaw);
    const explicitModelRawForProvider = provider === "local" ? explicitModelRaw : "";
    const commitsCount = yield* parseOptionalPositiveInteger(commitsCountRaw, "COMMITS_COUNT");
    const localRunnerCpus = yield* parseOptionalPositiveNumber(
      localRunnerCpusRaw,
      "LOCAL_RUNNER_CPUS",
    );
    const localRunnerMemoryGb = yield* parseOptionalPositiveNumber(
      localRunnerMemoryGbRaw,
      "LOCAL_RUNNER_MEMORY_GB",
    );
    const repositoryLayer =
      options.openRouterRepositoryLayer ??
      (provider === "openrouter"
        ? makeOpenRouterModelsRepositoryLive({
            ...(openRouterApiKeyRaw === ""
              ? {}
              : {
                  apiKey: Redacted.make(openRouterApiKeyRaw, { label: "OPENROUTER_API_KEY" }),
                }),
            siteTitle: openRouterTitleRaw === "" ? DEFAULT_OPENROUTER_TITLE : openRouterTitleRaw,
            ...(openRouterHttpRefererRaw === "" ? {} : { siteReferrer: openRouterHttpRefererRaw }),
          })
        : unusedOpenRouterModelsRepositoryLayer);
    yield* runBuildModelRoutingContext({
      workspace,
      defaultBranch,
      provider,
      explicitModel: explicitModelRawForProvider === "" ? undefined : explicitModelRawForProvider,
      ...(openRouterModelRaw === "" ? {} : { openRouterModel: openRouterModelRaw }),
      ...(openaiCompatUrlRaw === "" ? {} : { openaiCompatUrl: openaiCompatUrlRaw }),
      ...(llamacppModelUrlRaw === "" ? {} : { llamacppModelUrl: llamacppModelUrlRaw }),
      ...(runnerLabelRaw === "" ? {} : { runnerLabel: runnerLabelRaw }),
      ...(repositoryVisibilityRaw === "" ? {} : { repositoryVisibility: repositoryVisibilityRaw }),
      ...(localRunnerCpus === undefined ? {} : { localRunnerCpus }),
      ...(localRunnerMemoryGb === undefined ? {} : { localRunnerMemoryGb }),
      githubOutput,
      commitsCount,
    }).pipe(Effect.provide(repositoryLayer));
  });

export const program = makeProgram();

/* patch-coverage-ignore-start: CLI entrypoint block is not reachable from bun:test process coverage */
if (import.meta.main) {
  Effect.runPromise(program).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
/* patch-coverage-ignore-stop */
