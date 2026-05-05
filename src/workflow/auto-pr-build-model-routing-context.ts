import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Effect } from "effect";
import {
  buildGithubModelsRequestEnvelope,
  type GithubModelCatalogEntry,
  type GithubModelsPlanClass,
  type GithubModelsRequestEnvelope,
  parseGithubModelsRateLimitTier,
  pickGithubModelCatalogEntry,
  toModelBandRequestedEnvelopeInput,
} from "../core/github-model-routing.js";
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
import type { RoutingContextArtifact } from "../core/routing-artifacts.js";

type RoutingContextInputs = {
  readonly workspace: string;
  readonly defaultBranch: string;
  readonly provider: ModelProvider;
  readonly explicitModel: string | undefined;
  readonly openaiCompatUrl?: string;
  readonly llamacppModelUrl?: string;
  readonly runnerLabel?: string;
  readonly repositoryVisibility?: string;
  readonly localRunnerCpus?: number;
  readonly localRunnerMemoryGb?: number;
  readonly githubOutput: string;
  readonly commitsCount: number | undefined;
  readonly githubToken?: string;
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
  readonly githubModelsPlanClass: GithubModelsPlanClass;
  readonly githubModelsRateLimitTier: string;
  readonly githubModelsEnvelopeSource: string;
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
      if (raw === "local" || raw === "github-models") return raw;
      throw new Error(`AUTO_PR_AI_PROVIDER must be local or github-models, got ${raw}`);
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
      const result = spawnSync("git", [...args], { cwd: workspace, encoding: "utf8" });
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

function parseCatalogEntries(raw: unknown): readonly GithubModelCatalogEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: GithubModelCatalogEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : undefined;
    if (id === undefined || id.trim() === "") continue;
    const name = typeof candidate.name === "string" ? candidate.name : id;
    const capabilities = Array.isArray(candidate.capabilities)
      ? candidate.capabilities.filter((x): x is string => typeof x === "string")
      : [];
    const supportedInputModalities = Array.isArray(candidate.supported_input_modalities)
      ? candidate.supported_input_modalities.filter((x): x is string => typeof x === "string")
      : [];
    const supportedOutputModalities = Array.isArray(candidate.supported_output_modalities)
      ? candidate.supported_output_modalities.filter((x): x is string => typeof x === "string")
      : [];
    const limits =
      typeof candidate.limits === "object" && candidate.limits !== null
        ? (candidate.limits as Record<string, unknown>)
        : undefined;
    const maxInputTokens =
      typeof limits?.max_input_tokens === "number" && Number.isFinite(limits.max_input_tokens)
        ? limits.max_input_tokens
        : 8_000;
    const maxOutputTokens =
      typeof limits?.max_output_tokens === "number" && Number.isFinite(limits.max_output_tokens)
        ? limits.max_output_tokens
        : 2_000;
    const rateLimitTier = parseGithubModelsRateLimitTier(
      typeof candidate.rate_limit_tier === "string" ? candidate.rate_limit_tier : undefined,
    );
    entries.push({
      id,
      name,
      capabilities,
      supportedInputModalities,
      supportedOutputModalities,
      maxInputTokens,
      maxOutputTokens,
      rateLimitTier,
    });
  }
  return entries;
}

function fetchGithubModelsCatalog(
  token: string | undefined,
): Effect.Effect<readonly GithubModelCatalogEntry[], never> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = {
        accept: "application/json",
      };
      if (token !== undefined && token.trim() !== "") {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await fetch("https://models.github.ai/catalog/models", {
        method: "GET",
        headers,
      });
      if (!response.ok) return [];
      const json = (await response.json()) as unknown;
      return parseCatalogEntries(json);
    },
    catch: () => [],
  }).pipe(Effect.catch(() => Effect.succeed([])));
}

type RepoOwnerInfo = {
  readonly ownerLogin: string;
  readonly ownerType: "User" | "Organization" | "Unknown";
};

function fetchJson(url: string, token: string): Effect.Effect<unknown, never> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) return undefined;
      return (await response.json()) as unknown;
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseRepoOwnerInfo(json: unknown): RepoOwnerInfo | undefined {
  const record = asRecord(json);
  const owner = asRecord(record?.owner);
  const ownerLogin = typeof owner?.login === "string" ? owner.login.trim() : "";
  const ownerTypeRaw = typeof owner?.type === "string" ? owner.type : "Unknown";
  const ownerType: RepoOwnerInfo["ownerType"] =
    ownerTypeRaw === "Organization" || ownerTypeRaw === "User" ? ownerTypeRaw : "Unknown";
  return ownerLogin === "" ? undefined : { ownerLogin, ownerType };
}

function parseCopilotPlanType(json: unknown): string | undefined {
  const record = asRecord(json);
  const planType =
    typeof record?.plan_type === "string" ? record.plan_type.trim().toLowerCase() : "";
  return planType === "" ? undefined : planType;
}

function parseUserPlanName(json: unknown): string | undefined {
  const record = asRecord(json);
  const plan = asRecord(record?.plan);
  const name = typeof plan?.name === "string" ? plan.name.trim().toLowerCase() : "";
  return name === "" ? undefined : name;
}

function mapPlanSignalsToClass(input: {
  readonly ownerType: RepoOwnerInfo["ownerType"];
  readonly copilotPlanType?: string;
  readonly userPlanName?: string;
}): GithubModelsPlanClass {
  if (input.copilotPlanType === "business") return "copilot-business";
  if (input.copilotPlanType === "enterprise") return "copilot-enterprise";
  if (input.copilotPlanType === "pro") return "copilot-pro";
  if (input.copilotPlanType === "free") return "copilot-free";
  if (input.ownerType === "Organization") {
    if (input.userPlanName === "enterprise") return "copilot-enterprise";
    if (input.userPlanName === "team") return "copilot-business";
    return "unknown";
  }
  if (input.userPlanName === "pro") return "copilot-pro";
  if (input.userPlanName === "free") return "copilot-free";
  return "unknown";
}

function detectGithubModelsPlanClass(
  workspace: string,
  token: string | undefined,
): Effect.Effect<GithubModelsPlanClass, never> {
  if (token === undefined || token.trim() === "")
    return Effect.succeed<GithubModelsPlanClass>("unknown");
  return Effect.gen(function* () {
    const remote = yield* runGit(workspace, ["remote", "get-url", "origin"]).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.catch(() => Effect.succeed("")),
    );
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (match == null) {
      yield* Effect.logWarning({
        event: "build_model_routing_context",
        step: "plan_detection",
        status: "remote_parse_failed",
        remote,
      });
      return "unknown" as const;
    }
    const owner = match[1];
    const repo = match[2];
    const repoJson = yield* fetchJson(`https://api.github.com/repos/${owner}/${repo}`, token);
    const ownerInfo = parseRepoOwnerInfo(repoJson);
    if (ownerInfo === undefined) {
      yield* Effect.logWarning({
        event: "build_model_routing_context",
        step: "plan_detection",
        status: "owner_info_unavailable",
        owner,
        repo,
      });
      return "unknown" as const;
    }
    const userJson = yield* fetchJson("https://api.github.com/user", token);
    const userPlanName = parseUserPlanName(userJson);
    const copilotPlanType =
      ownerInfo.ownerType === "Organization"
        ? parseCopilotPlanType(
            yield* fetchJson(
              `https://api.github.com/orgs/${ownerInfo.ownerLogin}/copilot/billing`,
              token,
            ),
          )
        : undefined;
    const resolvedPlanClass = mapPlanSignalsToClass({
      ownerType: ownerInfo.ownerType,
      ...(copilotPlanType === undefined ? {} : { copilotPlanType }),
      ...(userPlanName === undefined ? {} : { userPlanName }),
    });
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "plan_detection",
      status: "resolved",
      owner: ownerInfo.ownerLogin,
      owner_type: ownerInfo.ownerType,
      copilot_plan_type: copilotPlanType ?? "unknown",
      user_plan_name: userPlanName ?? "unknown",
      plan_class: resolvedPlanClass,
    });
    return resolvedPlanClass;
  }).pipe(Effect.catch(() => Effect.succeed<GithubModelsPlanClass>("unknown")));
}

function buildEnvelope(
  decision: ModelBandDecision,
  signals: ModelBandSignals,
  planClass: GithubModelsPlanClass,
  catalogEntries: readonly GithubModelCatalogEntry[],
): {
  readonly envelope: GithubModelsRequestEnvelope;
  readonly selectedModel: string;
  readonly requiresToolCalls: boolean;
  readonly selectionMode: string;
} {
  const catalogSelection = pickGithubModelCatalogEntry({
    selectedModel: decision.selectedModel,
    entries: catalogEntries,
    requiresToolCalls: decision.requiresToolCalls,
  });
  const envelope = buildGithubModelsRequestEnvelope({
    model: catalogSelection.model,
    requiresToolCalls: catalogSelection.requiresToolCalls,
    planClass,
    requested: toModelBandRequestedEnvelopeInput({
      signals,
      promptCharsEstimate: estimatePromptChars(signals),
      toolStrategy: decision.toolStrategy,
      reasoningNeed: decision.reasoningNeed,
    }),
    ...(catalogSelection.catalogEntry === undefined
      ? {}
      : { catalogEntry: catalogSelection.catalogEntry }),
  });
  return {
    envelope,
    selectedModel: catalogSelection.model,
    requiresToolCalls: catalogSelection.requiresToolCalls,
    selectionMode: catalogSelection.selectionMode,
  };
}

function defaultEnvelopeForLocal(): RoutingEnvelopeOutput {
  return {
    tokenBudget: 12_000,
    toolRoundLimit: 6,
    toolResponseCharBudget: 8_000,
    githubModelsPlanClass: "unknown",
    githubModelsRateLimitTier: "unknown",
    githubModelsEnvelopeSource: "static-fallback",
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

function buildRoutingContextInput(
  input: RoutingContextInputs,
): Effect.Effect<RoutingContextSignalInput, Error> {
  return Effect.gen(function* () {
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
}

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
        selectionMode: envelope.githubModelsEnvelopeSource,
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
        `github_models_plan_class=${singleLine("github_models_plan_class", envelope.githubModelsPlanClass)}\n`,
      );
      appendFileSync(
        githubOutput,
        `github_models_rate_limit_tier=${singleLine("github_models_rate_limit_tier", envelope.githubModelsRateLimitTier)}\n`,
      );
      appendFileSync(
        githubOutput,
        `github_models_envelope_source=${singleLine("github_models_envelope_source", envelope.githubModelsEnvelopeSource)}\n`,
      );
    },
    catch: toError,
  });
}

export function runBuildModelRoutingContext(
  input: RoutingContextInputs,
): Effect.Effect<void, Error> {
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
      input.provider === "github-models"
        ? yield* Effect.gen(function* () {
            const autoPlanClass = yield* detectGithubModelsPlanClass(
              input.workspace,
              input.githubToken,
            );
            const catalogEntries = yield* fetchGithubModelsCatalog(input.githubToken);
            const built = buildEnvelope(
              decision,
              routingInput.signals,
              autoPlanClass,
              catalogEntries,
            );
            decision = {
              ...decision,
              selectedModel: built.selectedModel,
              requiresToolCalls: built.requiresToolCalls,
            };
            yield* Effect.log({
              event: "build_model_routing_context",
              step: "model_selection",
              status: "catalog_fallback_resolved",
              selected_model: built.selectedModel,
              requires_tool_calls: built.requiresToolCalls,
              selection_mode: built.selectionMode,
            });
            return {
              tokenBudget: built.envelope.tokenBudget,
              toolRoundLimit: built.envelope.toolRoundLimit,
              toolResponseCharBudget: built.envelope.toolResponseCharBudget,
              githubModelsPlanClass: built.envelope.planClass,
              githubModelsRateLimitTier: built.envelope.rateLimitTier,
              githubModelsEnvelopeSource: built.envelope.source,
            } satisfies RoutingEnvelopeOutput;
          })
        : defaultEnvelopeForLocal();
    yield* Effect.log({
      event: "build_model_routing_context",
      step: "envelope",
      status: "resolved",
      token_budget: envelopeResolved.tokenBudget,
      tool_round_limit: envelopeResolved.toolRoundLimit,
      tool_response_char_budget: envelopeResolved.toolResponseCharBudget,
      plan_class: envelopeResolved.githubModelsPlanClass,
      rate_limit_tier: envelopeResolved.githubModelsRateLimitTier,
      envelope_source: envelopeResolved.githubModelsEnvelopeSource,
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

export const program = Effect.gen(function* () {
  const workspace = yield* readRequiredEnv("GITHUB_WORKSPACE");
  const defaultBranch = yield* readRequiredEnv("DEFAULT_BRANCH");
  const providerRaw = yield* readRequiredEnv("AUTO_PR_AI_PROVIDER");
  const githubOutput = yield* readRequiredEnv("GITHUB_OUTPUT");
  const explicitModelRaw = yield* Effect.sync(() => process.env.AUTO_PR_LOCAL_MODEL?.trim() ?? "");
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
  const localRunnerCpusRaw = yield* Effect.sync(() => process.env.LOCAL_RUNNER_CPUS?.trim() ?? "");
  const localRunnerMemoryGbRaw = yield* Effect.sync(
    () => process.env.LOCAL_RUNNER_MEMORY_GB?.trim() ?? "",
  );
  const commitsCountRaw = yield* Effect.sync(() => process.env.COMMITS_COUNT?.trim() ?? "");
  const githubTokenRaw = yield* Effect.sync(
    () => process.env.GH_TOKEN?.trim() ?? process.env.GITHUB_TOKEN?.trim() ?? "",
  );
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
  yield* runBuildModelRoutingContext({
    workspace,
    defaultBranch,
    provider,
    explicitModel: explicitModelRawForProvider === "" ? undefined : explicitModelRawForProvider,
    ...(openaiCompatUrlRaw === "" ? {} : { openaiCompatUrl: openaiCompatUrlRaw }),
    ...(llamacppModelUrlRaw === "" ? {} : { llamacppModelUrl: llamacppModelUrlRaw }),
    ...(runnerLabelRaw === "" ? {} : { runnerLabel: runnerLabelRaw }),
    ...(repositoryVisibilityRaw === "" ? {} : { repositoryVisibility: repositoryVisibilityRaw }),
    ...(localRunnerCpus === undefined ? {} : { localRunnerCpus }),
    ...(localRunnerMemoryGb === undefined ? {} : { localRunnerMemoryGb }),
    githubOutput,
    commitsCount,
    ...(githubTokenRaw === "" ? {} : { githubToken: githubTokenRaw }),
  });
});

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
