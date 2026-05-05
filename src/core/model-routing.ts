/**
 * Routing policy for auto-pr's packaged build-model-routing-context workflow command.
 */

export type ModelProvider = "local" | "github-models";

export type ModelBand = "A" | "B" | "C";

export type ToolStrategy = "none" | "hotspot" | "full-diff" | "commit-diff";

export type ReasoningNeed = "low" | "medium" | "high";

export type LocalModelResourceFit = "compatible" | "risky" | "unknown" | "not-applicable";

export type LocalRunnerResources = {
  readonly label: string;
  readonly cpuCount: number;
  readonly memoryGb: number;
  readonly profile: string;
};

export type LocalModelContext = {
  readonly openaiCompatUrl?: string;
  readonly llamacppModelUrl?: string;
  readonly runner: LocalRunnerResources;
};

export type ModelBandSignals = {
  readonly semanticCommitCount: number;
  readonly conventionalTypeCount: number;
  readonly topLevelSpread: number;
  readonly changedFileCount: number;
  readonly sourceFileCount: number;
  readonly docsFileCount: number;
  readonly testFileCount: number;
  readonly generatedFileCount: number;
  readonly lockfileCount: number;
  readonly packageManifestCount: number;
  readonly rawChurn: number;
  readonly sourceChurn: number;
  readonly generatedChurn: number;
  readonly hasBreakingChange: boolean;
  readonly hasBinaryFiles: boolean;
};

export type ModelBandDecision = {
  readonly band: ModelBand;
  readonly selectedModel: string;
  readonly routingContext: string;
  readonly toolStrategy: ToolStrategy;
  readonly reasoningNeed: ReasoningNeed;
  readonly requiresToolCalls: boolean;
  readonly localRunnerResources?: string;
  readonly localModelResourceFit?: LocalModelResourceFit;
  readonly localModelRecommendation?: string;
};

export type ResolveModelBandInput = {
  readonly provider: ModelProvider;
  readonly explicitModel?: string;
  readonly signals: ModelBandSignals;
  readonly localModel?: LocalModelContext;
};

export type RoutingContextHotspot = {
  path: string;
  churn: number;
  insertions: number;
  deletions: number;
  kind: string;
};

export type RoutingContextCommitSummary = {
  readonly semanticCommitCount: number;
  readonly mergeCommitCount: number;
  readonly breakingCommitCount: number;
  readonly typeCounts: Readonly<Record<string, number>>;
};

export type RoutingContextFileSummary = {
  readonly changedFiles: readonly string[];
  readonly topLevelDirs: readonly string[];
  readonly topFiles: readonly RoutingContextHotspot[];
  readonly topDirs: readonly RoutingContextHotspot[];
  readonly sourceFileCount: number;
  readonly docsFileCount: number;
  readonly testFileCount: number;
  readonly generatedFileCount: number;
  readonly lockfileCount: number;
  readonly packageManifestCount: number;
  readonly rawChurn: number;
  readonly sourceChurn: number;
  readonly generatedChurn: number;
  readonly hasBinaryFiles: boolean;
  readonly addedFileCount: number;
  readonly modifiedFileCount: number;
  readonly deletedFileCount: number;
  readonly renamedFileCount: number;
};

export type BuildDetailedRoutingContextInput = {
  readonly band: ModelBand;
  readonly selectedModel: string;
  readonly toolStrategy: ToolStrategy;
  readonly reasoningNeed: ReasoningNeed;
  readonly requiresToolCalls: boolean;
  readonly signals: ModelBandSignals;
  readonly commits: RoutingContextCommitSummary;
  readonly files: RoutingContextFileSummary;
  readonly localRunnerResources?: string;
  readonly localModelResourceFit?: LocalModelResourceFit;
  readonly localModelRecommendation?: string;
};

export type ParsedCommit = {
  readonly subject: string;
  readonly type: string | undefined;
  readonly breaking: boolean;
};

const GITHUB_MODELS_SMALL_MODEL = "microsoft/phi-4-mini-instruct";
const GITHUB_MODELS_STRONG_MODEL = "openai/gpt-4.1";

const LOCAL_TINY_MODEL = "qwen3-0.6b-q4_k_m";
const LOCAL_SMALL_MODEL = "qwen3-1.7b-q4_k_m";
const LOCAL_MEDIUM_MODEL = "qwen3-4b-q4_k_m";
const LOCAL_LARGE_MODEL = "gpt-oss";

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator * 100) / denominator);
}

function hasDocsAndSource(signals: ModelBandSignals): boolean {
  return signals.docsFileCount > 0 && signals.sourceFileCount > 0;
}

function hasTestsAndSource(signals: ModelBandSignals): boolean {
  return signals.testFileCount > 0 && signals.sourceFileCount > 0;
}

function isDocsOnly(signals: ModelBandSignals): boolean {
  return (
    signals.docsFileCount > 0 &&
    signals.sourceFileCount === 0 &&
    signals.testFileCount === 0 &&
    signals.generatedFileCount === 0
  );
}

function isGeneratedOnly(signals: ModelBandSignals): boolean {
  return (
    signals.generatedFileCount > 0 &&
    signals.sourceFileCount === 0 &&
    signals.docsFileCount === 0 &&
    signals.testFileCount === 0
  );
}

function isTinyAndFocused(signals: ModelBandSignals): boolean {
  return (
    signals.semanticCommitCount <= 2 &&
    signals.changedFileCount <= 3 &&
    signals.topLevelSpread <= 1 &&
    signals.sourceChurn < 200 &&
    signals.conventionalTypeCount <= 2
  );
}

function isBroadChange(signals: ModelBandSignals): boolean {
  return (
    signals.hasBreakingChange ||
    signals.sourceChurn >= 1200 ||
    signals.semanticCommitCount >= 8 ||
    signals.conventionalTypeCount >= 3 ||
    signals.topLevelSpread >= 3 ||
    (signals.changedFileCount >= 15 && signals.sourceFileCount >= 4)
  );
}

function isCrossCutting(signals: ModelBandSignals): boolean {
  return (
    hasDocsAndSource(signals) ||
    hasTestsAndSource(signals) ||
    signals.lockfileCount > 0 ||
    signals.packageManifestCount > 0
  );
}

function isGeneratedDominant(signals: ModelBandSignals): boolean {
  return (
    signals.rawChurn > 0 &&
    safeRatio(signals.generatedChurn, signals.rawChurn) >= 80 &&
    signals.sourceChurn < 120
  );
}

export function resolveBand(signals: ModelBandSignals): ModelBand {
  if (signals.hasBreakingChange) {
    return "C";
  }
  if (
    isGeneratedDominant(signals) ||
    isTinyAndFocused(signals) ||
    isDocsOnly(signals) ||
    isGeneratedOnly(signals)
  ) {
    return "A";
  }
  if (isBroadChange(signals) || (isCrossCutting(signals) && signals.sourceChurn >= 400)) {
    return "C";
  }
  return "B";
}

function resolveReasoningNeed(signals: ModelBandSignals, band: ModelBand): ReasoningNeed {
  if (
    band === "C" ||
    signals.hasBreakingChange ||
    signals.sourceChurn >= 1200 ||
    signals.topLevelSpread >= 4
  ) {
    return "high";
  }
  if (band === "B") return "medium";
  return "low";
}

function resolveToolStrategy(signals: ModelBandSignals, band: ModelBand): ToolStrategy {
  if (band === "A" && !signals.hasBreakingChange) return "none";
  if (
    band === "C" ||
    signals.hasBreakingChange ||
    signals.sourceChurn >= 1200 ||
    signals.topLevelSpread >= 4 ||
    (signals.changedFileCount >= 15 && signals.sourceFileCount >= 4)
  ) {
    return "full-diff";
  }
  if (signals.semanticCommitCount >= 4 && signals.conventionalTypeCount >= 2) {
    return "commit-diff";
  }
  if (
    signals.sourceFileCount > 0 ||
    signals.testFileCount > 0 ||
    signals.packageManifestCount > 0 ||
    signals.lockfileCount > 0
  ) {
    return "hotspot";
  }
  return "none";
}

export function resolveLocalRunnerResources(input: {
  readonly runnerLabel?: string;
  readonly repositoryVisibility?: string;
  readonly cpuCount?: number;
  readonly memoryGb?: number;
}): LocalRunnerResources {
  const label = input.runnerLabel?.trim() || "ubuntu-24.04";
  const visibility = input.repositoryVisibility?.trim().toLowerCase() ?? "";
  const privateLike =
    visibility === "" ||
    visibility === "private" ||
    visibility === "internal" ||
    visibility === "true";
  const inferred =
    label === "ubuntu-slim"
      ? { cpuCount: 1, memoryGb: 5 }
      : privateLike
        ? { cpuCount: 2, memoryGb: 8 }
        : { cpuCount: 4, memoryGb: 16 };
  const cpuCount =
    input.cpuCount !== undefined && input.cpuCount > 0 ? input.cpuCount : inferred.cpuCount;
  const memoryGb =
    input.memoryGb !== undefined && input.memoryGb > 0 ? input.memoryGb : inferred.memoryGb;
  const profile =
    label === "ubuntu-slim"
      ? "github-hosted ubuntu-slim"
      : privateLike
        ? `github-hosted ${label} private/internal baseline`
        : `github-hosted ${label} public baseline`;
  return { label, cpuCount, memoryGb, profile };
}

function selectLocalModelForRunner(runner: LocalRunnerResources): string {
  if (runner.memoryGb <= 5 || runner.cpuCount <= 1) return LOCAL_TINY_MODEL;
  if (runner.memoryGb <= 8 || runner.cpuCount <= 2) return LOCAL_SMALL_MODEL;
  if (runner.memoryGb <= 16 || runner.cpuCount <= 4) return LOCAL_MEDIUM_MODEL;
  return LOCAL_LARGE_MODEL;
}

function recommendedMaxParamsB(runner: LocalRunnerResources): number {
  if (runner.memoryGb <= 5 || runner.cpuCount <= 1) return 1;
  if (runner.memoryGb <= 8 || runner.cpuCount <= 2) return 3;
  if (runner.memoryGb <= 16 || runner.cpuCount <= 4) return 7;
  if (runner.memoryGb <= 32) return 14;
  return 32;
}

function estimateParamsBFromModelUrl(modelUrl: string | undefined): number | undefined {
  if (isBlank(modelUrl)) return undefined;
  let decoded = modelUrl ?? "";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return undefined;
  }
  const matches = [...decoded.matchAll(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*[bB](?:[^a-zA-Z]|$)/g)];
  if (matches.length === 0) return undefined;
  const values = matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0);
  return values.length === 0 ? undefined : Math.max(...values);
}

function usesExternalOpenAiCompat(localModel: LocalModelContext | undefined): boolean {
  return !isBlank(localModel?.openaiCompatUrl);
}

function resolveLocalModelResourceFit(input: {
  readonly localModel?: LocalModelContext;
}): LocalModelResourceFit | undefined {
  const local = input.localModel;
  if (local === undefined) return undefined;
  if (!isBlank(local.openaiCompatUrl)) return "not-applicable";
  const modelUrl = local.llamacppModelUrl;
  if (isBlank(modelUrl)) return "unknown";
  const estimated = estimateParamsBFromModelUrl(modelUrl);
  if (estimated === undefined) return "unknown";
  return estimated <= recommendedMaxParamsB(local.runner) ? "compatible" : "risky";
}

function formatLocalRunnerResources(runner: LocalRunnerResources): string {
  return `${runner.profile}; cpu=${runner.cpuCount}; memory=${runner.memoryGb}GB`;
}

export function selectModel(
  provider: ModelProvider,
  band: ModelBand,
  explicitModel?: string,
  routing?: {
    readonly requiresToolCalls?: boolean;
    readonly reasoningNeed?: ReasoningNeed;
    readonly localModel?: LocalModelContext;
  },
): string {
  const override = explicitModel?.trim() ?? "";
  if (provider === "local" && !isBlank(override)) return override;
  if (provider === "github-models") {
    return band === "C" || routing?.requiresToolCalls === true || routing?.reasoningNeed === "high"
      ? GITHUB_MODELS_STRONG_MODEL
      : GITHUB_MODELS_SMALL_MODEL;
  }
  if (usesExternalOpenAiCompat(routing?.localModel)) return LOCAL_LARGE_MODEL;
  return selectLocalModelForRunner(
    routing?.localModel?.runner ?? resolveLocalRunnerResources({ repositoryVisibility: "private" }),
  );
}

export function resolveModelBand(input: ResolveModelBandInput): ModelBandDecision {
  const band = resolveBand(input.signals);
  const reasoningNeed = resolveReasoningNeed(input.signals, band);
  const toolStrategy = resolveToolStrategy(input.signals, band);
  const requiresToolCalls = toolStrategy !== "none";
  const selectedModel = selectModel(input.provider, band, input.explicitModel, {
    reasoningNeed,
    requiresToolCalls,
    ...(input.localModel === undefined ? {} : { localModel: input.localModel }),
  });
  const externalOpenAiCompat =
    input.provider === "local" && usesExternalOpenAiCompat(input.localModel);
  const localRunnerResources =
    input.provider === "local" && input.localModel !== undefined && !externalOpenAiCompat
      ? formatLocalRunnerResources(input.localModel.runner)
      : undefined;
  const localModelRecommendation =
    input.provider === "local" && input.localModel !== undefined
      ? externalOpenAiCompat
        ? `external OpenAI-compatible endpoint; default model=${LOCAL_LARGE_MODEL}; set AUTO_PR_LOCAL_MODEL if the endpoint requires another id`
        : `${selectLocalModelForRunner(input.localModel.runner)}; recommended GGUF <= ${recommendedMaxParamsB(input.localModel.runner)}B Q4-class on this runner`
      : undefined;
  const localModelResourceFit =
    input.provider === "local" && input.localModel !== undefined
      ? resolveLocalModelResourceFit({ localModel: input.localModel })
      : undefined;
  return {
    band,
    selectedModel,
    routingContext: "",
    toolStrategy,
    reasoningNeed,
    requiresToolCalls,
    ...(localRunnerResources === undefined ? {} : { localRunnerResources }),
    ...(localModelResourceFit === undefined ? {} : { localModelResourceFit }),
    ...(localModelRecommendation === undefined ? {} : { localModelRecommendation }),
  };
}

function formatCountLabel(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

function joinList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function formatTypeCounts(typeCounts: Readonly<Record<string, number>>): string {
  const order = [
    "feat",
    "fix",
    "docs",
    "refactor",
    "test",
    "perf",
    "ci",
    "build",
    "chore",
    "revert",
  ];
  const entries = Object.entries(typeCounts).filter(([, count]) => count > 0);
  const sorted = entries.sort(([a], [b]) => {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return sorted.length === 0
    ? "none"
    : sorted.map(([type, count]) => `${type}=${count}`).join(", ");
}

function formatHotspots(hotspots: readonly RoutingContextHotspot[]): string {
  if (hotspots.length === 0) return "none";
  return hotspots
    .map((spot) => `${spot.path} (+${spot.insertions}/-${spot.deletions}, ${spot.kind})`)
    .join("; ");
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return `${Math.floor((numerator * 100) / denominator)}%`;
}

function summarizeScope(files: RoutingContextFileSummary): string {
  return files.docsFileCount > 0 &&
    files.sourceFileCount === 0 &&
    files.testFileCount === 0 &&
    files.generatedFileCount === 0
    ? "docs-only"
    : files.sourceFileCount > 0 &&
        files.docsFileCount === 0 &&
        files.testFileCount === 0 &&
        files.generatedFileCount === 0
      ? "source-only"
      : files.testFileCount > 0 &&
          files.sourceFileCount === 0 &&
          files.docsFileCount === 0 &&
          files.generatedFileCount === 0
        ? "test-only"
        : files.generatedFileCount > 0 &&
            files.sourceFileCount === 0 &&
            files.docsFileCount === 0 &&
            files.testFileCount === 0
          ? "generated-only"
          : files.docsFileCount > 0 && files.sourceFileCount > 0
            ? "docs+source"
            : files.testFileCount > 0 && files.sourceFileCount > 0
              ? "tests+source"
              : files.lockfileCount > 0 || files.packageManifestCount > 0
                ? "dependency/config"
                : "mixed";
}

function summarizeCoverage(files: RoutingContextFileSummary): string {
  if (files.sourceFileCount > 0 && files.testFileCount > 0) return "source+tests";
  if (files.sourceFileCount > 0) return "source-without-tests";
  if (files.testFileCount > 0) return "tests-only";
  return "no-source";
}

function summarizeReviewFocus(files: RoutingContextFileSummary): string {
  const priorityKinds = new Set(["source", "test", "package", "lockfile", "other"]);
  const focused = files.topFiles.filter((file) => priorityKinds.has(file.kind));
  const hotspots = focused.length > 0 ? focused : files.topFiles;
  return formatHotspots(hotspots.slice(0, 3));
}

function summarizeSensitiveScope(files: RoutingContextFileSummary): string {
  const paths = files.changedFiles;
  const scopes = [
    paths.some((path) => path.startsWith(".github/workflows/")) ? "workflows" : "",
    paths.some((path) => path.startsWith(".github/actions/")) ? "composite-actions" : "",
    paths.some((path) => path.startsWith("src/auto-pr/prompts/")) ? "prompts" : "",
    paths.some((path) => path === "src/auto-pr/config.ts" || path.includes(".env"))
      ? "config/env"
      : "",
    paths.some((path) => /(auth|token|secret|ai-provider|pull-request-client)/i.test(path))
      ? "auth/provider"
      : "",
    paths.some((path) =>
      /^(package(?:-lock)?\.json|bun\.lock|bun\.lockb|bun\.nix|flake\.(nix|lock))$/.test(path),
    )
      ? "dependencies"
      : "",
    paths.some((path) => path === "src/core/index.ts" || path === "src/auto-pr/index.ts")
      ? "exported-api"
      : "",
  ].filter(Boolean);
  return scopes.length === 0 ? "none" : scopes.join(", ");
}

function summarizePublicSurface(files: RoutingContextFileSummary): string {
  const paths = files.changedFiles;
  const surfaces = [
    paths.some((path) => path.endsWith("action.yml") || path.startsWith(".github/workflows/"))
      ? "workflow/action contract"
      : "",
    paths.some((path) => path.startsWith("src/tools/")) ? "cli" : "",
    paths.some((path) => path.startsWith("src/workflow/")) ? "workflow command" : "",
    paths.some((path) => path === "src/auto-pr/config.ts") ? "config/env" : "",
    paths.some((path) => path.startsWith("src/auto-pr/prompts/")) ? "prompt" : "",
    paths.some((path) => path === "src/core/index.ts" || path === "src/auto-pr/index.ts")
      ? "exported-api"
      : "",
  ].filter(Boolean);
  return surfaces.length === 0 ? "none" : surfaces.join(", ");
}

function summarizeChangeShape(input: {
  readonly scope: string;
  readonly signals: ModelBandSignals;
  readonly files: RoutingContextFileSummary;
  readonly generatedRatio: string;
}): string {
  const { scope, signals, files, generatedRatio } = input;
  const shapes = [
    scope,
    signals.rawChurn > 0 && signals.generatedChurn * 100 >= signals.rawChurn * 80
      ? `generated-heavy (${generatedRatio})`
      : "",
    files.addedFileCount > 0 ? `added=${files.addedFileCount}` : "",
    files.modifiedFileCount > 0 ? `modified=${files.modifiedFileCount}` : "",
    files.deletedFileCount > 0 ? `deleted=${files.deletedFileCount}` : "",
    files.renamedFileCount > 0 ? `renamed=${files.renamedFileCount}` : "",
    signals.topLevelSpread >= 3 ? `cross-dir=${signals.topLevelSpread}` : "",
  ].filter(Boolean);
  return shapes.join(", ");
}

function summarizeToolGuidance(toolStrategy: ToolStrategy): string {
  const guidance: Record<ToolStrategy, string> = {
    none: "no tools needed; use commits and diff stat",
    hotspot: "inspect review_focus files before writing risks or reviewer notes",
    "full-diff": "inspect full diff first; if truncated, inspect review_focus files",
    "commit-diff": "inspect commit diffs for mixed intent before writing risks",
  };
  return guidance[toolStrategy];
}

export function buildDetailedRoutingContext(input: BuildDetailedRoutingContextInput): string {
  const {
    band,
    selectedModel,
    toolStrategy,
    reasoningNeed,
    requiresToolCalls,
    signals,
    commits,
    files,
    localRunnerResources,
    localModelResourceFit,
    localModelRecommendation,
  } = input;
  const generatedRatio = formatPercent(signals.generatedChurn, signals.rawChurn);
  const sourceRatio = formatPercent(signals.sourceChurn, signals.rawChurn);
  const scope = summarizeScope(files);
  const flags = [
    signals.hasBreakingChange ? "breaking" : "",
    signals.hasBinaryFiles ? "binary" : "",
    files.lockfileCount > 0 ? "lockfiles" : "",
    files.packageManifestCount > 0 ? "package-manifests" : "",
    files.docsFileCount > 0 && files.sourceFileCount > 0 ? "docs+src" : "",
    files.testFileCount > 0 && files.sourceFileCount > 0 ? "tests+src" : "",
    localModelResourceFit === "risky" ? "local-model-resource-risk" : "",
  ].filter(Boolean);
  const decisionReason =
    band === "C"
      ? "broad / cross-cutting / breaking"
      : band === "A"
        ? "tight / docs-only / generated-heavy"
        : "mixed but bounded";
  const localLines = [
    ...(localRunnerResources === undefined ? [] : [`local_runner: ${localRunnerResources}`]),
    ...(localModelResourceFit === undefined && localModelRecommendation === undefined
      ? []
      : [
          `local_model: fit=${localModelResourceFit ?? "unknown"}; recommendation=${localModelRecommendation ?? "none"}`,
        ]),
  ];
  const lines = [
    "Trusted change analysis:",
    `decision: band=${band}; reason=${decisionReason}`,
    `intent: ${formatCountLabel(commits.semanticCommitCount, "semantic commit")}; merge=${commits.mergeCommitCount}; breaking=${commits.breakingCommitCount}; types=${formatTypeCounts(commits.typeCounts)}`,
    `scope: ${scope}; dirs=${joinList(files.topLevelDirs.slice(0, 8))}`,
    `file-kinds: source=${files.sourceFileCount}; docs=${files.docsFileCount}; test=${files.testFileCount}; generated=${files.generatedFileCount}; lockfiles=${files.lockfileCount}; package-manifests=${files.packageManifestCount}`,
    `churn: raw=${files.rawChurn}; source=${files.sourceChurn}; generated=${files.generatedChurn}; generated-share=${generatedRatio}; source-share=${sourceRatio}`,
    `hotspots: files=${formatHotspots(files.topFiles.slice(0, 5))}; dirs=${formatHotspots(files.topDirs.slice(0, 5))}`,
    `review_focus: ${summarizeReviewFocus(files)}`,
    `coverage_signal: ${summarizeCoverage(files)}`,
    `change_shape: ${summarizeChangeShape({ scope, signals, files, generatedRatio })}`,
    `public_surface: ${summarizePublicSurface(files)}`,
    `sensitive_scope: ${summarizeSensitiveScope(files)}`,
    ...localLines,
    `risk: ${flags.length === 0 ? "none" : flags.join(", ")}`,
    `tool_guidance: ${summarizeToolGuidance(toolStrategy)}`,
    `model_route: band=${band}; reasoning=${reasoningNeed}; tool_strategy=${toolStrategy}; requires_tool_calls=${requiresToolCalls ? "true" : "false"}; selected_model=${selectedModel}`,
  ];
  return lines.join("\n");
}

export function parseCommitLog(logOutput: string): readonly ParsedCommit[] {
  return logOutput
    .split("\0")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const first = lines[0] ?? "";
      const messageLines = /^[0-9a-f]{40}$/i.test(first) ? lines.slice(1) : lines;
      const subject = (messageLines[0] ?? "").trim();
      const body = messageLines.slice(1).join("\n");
      const header = /^([a-z]+)(?:\([^)]+\))?(!)?:\s+.+$/i.exec(subject);
      return {
        subject,
        type: header?.[1]?.toLowerCase(),
        breaking: header?.[2] === "!" || /^BREAKING[ -]CHANGE:/im.test(body),
      };
    });
}
