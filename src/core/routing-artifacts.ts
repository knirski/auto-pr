import { Schema } from "effect";
import type {
  LocalModelResourceFit,
  ModelBand,
  ModelBandSignals,
  ModelProvider,
  ReasoningNeed,
  RoutingContextCommitSummary,
  RoutingContextFileSummary,
  ToolStrategy,
} from "#core/model-routing.js";

const ModelProviderSchema = Schema.Union([
  Schema.Literal("local"),
  Schema.Literal("github-models"),
]);
const ModelBandSchema = Schema.Union([
  Schema.Literal("A"),
  Schema.Literal("B"),
  Schema.Literal("C"),
]);
const ToolStrategySchema = Schema.Union([
  Schema.Literal("none"),
  Schema.Literal("hotspot"),
  Schema.Literal("full-diff"),
  Schema.Literal("commit-diff"),
]);
const ReasoningNeedSchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
]);
const LocalModelResourceFitSchema = Schema.Union([
  Schema.Literal("compatible"),
  Schema.Literal("risky"),
  Schema.Literal("unknown"),
  Schema.Literal("not-applicable"),
]);

const RoutingContextHotspotSchema = Schema.Struct({
  path: Schema.String,
  churn: Schema.Number,
  insertions: Schema.Number,
  deletions: Schema.Number,
  kind: Schema.String,
});

const RoutingContextCommitSummarySchema = Schema.Struct({
  semanticCommitCount: Schema.Number,
  mergeCommitCount: Schema.Number,
  breakingCommitCount: Schema.Number,
  typeCounts: Schema.Record(Schema.String, Schema.Number),
});

const RoutingContextFileSummarySchema = Schema.Struct({
  changedFiles: Schema.Array(Schema.String),
  topLevelDirs: Schema.Array(Schema.String),
  topFiles: Schema.Array(RoutingContextHotspotSchema),
  topDirs: Schema.Array(RoutingContextHotspotSchema),
  sourceFileCount: Schema.Number,
  docsFileCount: Schema.Number,
  testFileCount: Schema.Number,
  generatedFileCount: Schema.Number,
  lockfileCount: Schema.Number,
  packageManifestCount: Schema.Number,
  rawChurn: Schema.Number,
  sourceChurn: Schema.Number,
  generatedChurn: Schema.Number,
  hasBinaryFiles: Schema.Boolean,
  addedFileCount: Schema.Number,
  modifiedFileCount: Schema.Number,
  deletedFileCount: Schema.Number,
  renamedFileCount: Schema.Number,
});

const ModelBandSignalsSchema = Schema.Struct({
  semanticCommitCount: Schema.Number,
  conventionalTypeCount: Schema.Number,
  topLevelSpread: Schema.Number,
  changedFileCount: Schema.Number,
  sourceFileCount: Schema.Number,
  docsFileCount: Schema.Number,
  testFileCount: Schema.Number,
  generatedFileCount: Schema.Number,
  lockfileCount: Schema.Number,
  packageManifestCount: Schema.Number,
  rawChurn: Schema.Number,
  sourceChurn: Schema.Number,
  generatedChurn: Schema.Number,
  hasBreakingChange: Schema.Boolean,
  hasBinaryFiles: Schema.Boolean,
});

export const RoutingDecisionSchema = Schema.Struct({
  provider: Schema.optional(ModelProviderSchema),
  selectedModel: Schema.String,
  requiresToolCalls: Schema.Boolean,
  tokenBudget: Schema.optional(Schema.Number),
  toolRoundLimit: Schema.optional(Schema.Number),
  toolResponseCharBudget: Schema.optional(Schema.Number),
  band: Schema.optional(ModelBandSchema),
  selectionMode: Schema.optional(Schema.String),
});

export type RoutingDecision = {
  readonly provider: ModelProvider | undefined;
  readonly selectedModel: string;
  readonly requiresToolCalls: boolean;
  readonly tokenBudget: number | undefined;
  readonly toolRoundLimit: number | undefined;
  readonly toolResponseCharBudget: number | undefined;
  readonly band: ModelBand | undefined;
  readonly selectionMode: string | undefined;
};

export const RoutingContextSchema = Schema.Struct({
  provider: ModelProviderSchema,
  band: ModelBandSchema,
  selectedModel: Schema.String,
  toolStrategy: ToolStrategySchema,
  reasoningNeed: ReasoningNeedSchema,
  requiresToolCalls: Schema.Boolean,
  signals: ModelBandSignalsSchema,
  commits: RoutingContextCommitSummarySchema,
  files: RoutingContextFileSummarySchema,
  localRunnerResources: Schema.optional(Schema.String),
  localModelResourceFit: Schema.optional(LocalModelResourceFitSchema),
  localModelRecommendation: Schema.optional(Schema.String),
});

export type RoutingContextArtifact = {
  readonly provider: ModelProvider;
  readonly band: ModelBand;
  readonly selectedModel: string;
  readonly toolStrategy: ToolStrategy;
  readonly reasoningNeed: ReasoningNeed;
  readonly requiresToolCalls: boolean;
  readonly signals: ModelBandSignals;
  readonly commits: RoutingContextCommitSummary;
  readonly files: RoutingContextFileSummary;
  readonly localRunnerResources: string | undefined;
  readonly localModelResourceFit: LocalModelResourceFit | undefined;
  readonly localModelRecommendation: string | undefined;
};
