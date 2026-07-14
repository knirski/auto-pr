import { Effect, FileSystem, Match, Path } from "effect";
import {
  GitContext,
  PR_BODY_FILE_NAME,
  PR_TITLE_FILE_NAME,
  type RunAutoPrConfig as RunAutoPrConfigService,
  UnexpectedError,
  unknownToMessage,
} from "#auto-pr";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";
import {
  type RunGeneratePrContentWithServicesConfig,
  runGeneratePrContentWithServices,
} from "#workflow/auto-pr-generate-content.js";

export function resolveRunAutoPrBranch(config: RunAutoPrConfigService) {
  if (config.branch !== undefined) return Effect.succeed(config.branch);
  return Effect.fn("resolveRunAutoPrBranch")(function* () {
    const git = yield* GitContext;
    return yield* git.getCurrentBranch();
  })().pipe(Effect.mapError((e) => new UnexpectedError({ cause: unknownToMessage(e) })));
}

export function prTitleReadError(error: unknown): UnexpectedError {
  return new UnexpectedError({
    cause: `${PR_TITLE_FILE_NAME}: ${unknownToMessage(error)}`,
  });
}

export function generateContentConfigFromRunAutoPrConfig(
  config: RunAutoPrConfigService,
  branch: string,
): RunGeneratePrContentWithServicesConfig {
  const common = {
    defaultBranch: config.defaultBranch,
    branch,
    workspace: config.workspace,
    templatePath: config.templatePath,
    model: config.model,
    ...(config.routingContext !== undefined ? { routingContext: config.routingContext } : {}),
    ...(config.aiToolRoundLimit !== undefined ? { aiToolRoundLimit: config.aiToolRoundLimit } : {}),
    ...(config.aiTokenBudget !== undefined ? { aiTokenBudget: config.aiTokenBudget } : {}),
    ...(config.aiToolResponseCharBudget !== undefined
      ? { aiToolResponseCharBudget: config.aiToolResponseCharBudget }
      : {}),
    ...(config.aiTokenBudget !== undefined ||
    config.aiToolRoundLimit !== undefined ||
    config.aiToolResponseCharBudget !== undefined
      ? { aiLimitsSource: "routing_decision" as const }
      : {}),
    ...(config.existingPrTitle !== undefined ? { existingPrTitle: config.existingPrTitle } : {}),
  };
  return Match.value(config).pipe(
    Match.when(
      { provider: "github-models" },
      (): RunGeneratePrContentWithServicesConfig => ({
        ...common,
        provider: "github-models",
      }),
    ),
    Match.when(
      { provider: "local" },
      (): RunGeneratePrContentWithServicesConfig => ({
        ...common,
        provider: "local",
      }),
    ),
    Match.exhaustive,
  );
}

/**
 * Run the local auto-PR pipeline using services from the environment.
 *
 * This keeps orchestration testable: live GitHub, git, AI, filesystem, and path
 * implementations are provided by the CLI adapter.
 */
export const runAutoPrPipelineWithServices = Effect.fn("runAutoPrPipelineWithServices")(
  function* (config: RunAutoPrConfigService) {
    const pathApi = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const { workspace, defaultBranch } = config;
    const branchVal = yield* resolveRunAutoPrBranch(config);

    yield* Effect.log({ event: "run_auto_pr", step: "generate_content" });
    yield* runGeneratePrContentWithServices(
      generateContentConfigFromRunAutoPrConfig(config, branchVal),
    );

    const titlePath = pathApi.join(workspace, PR_TITLE_FILE_NAME);
    const bodyPath = pathApi.join(workspace, PR_BODY_FILE_NAME);
    const title = (yield* fs
      .readFileString(titlePath)
      .pipe(Effect.mapError(prTitleReadError))).trim();

    yield* Effect.log({ event: "run_auto_pr", step: "create_or_update_pr" });
    yield* runCreateOrUpdatePr({
      branch: branchVal,
      defaultBranch,
      title,
      bodyFile: bodyPath,
      workspace,
    });

    yield* Effect.log({ event: "run_auto_pr", status: "done" });
  },
);
