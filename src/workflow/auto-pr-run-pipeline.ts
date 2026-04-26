import { Effect, FileSystem, Path } from "effect";
import {
	GitContext,
	PR_BODY_FILE_NAME,
	PR_TITLE_FILE_NAME,
	type RunAutoPrConfig as RunAutoPrConfigService,
	UnexpectedError,
	unknownToMessage,
} from "#auto-pr";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";
import { runGeneratePrContentWithServices } from "#workflow/auto-pr-generate-content.js";

export function resolveRunAutoPrBranch(config: RunAutoPrConfigService) {
	if (config.branch !== undefined) return Effect.succeed(config.branch);
	return Effect.gen(function* () {
		const git = yield* GitContext;
		return yield* git.getCurrentBranch();
	}).pipe(Effect.mapError((e) => new UnexpectedError({ cause: unknownToMessage(e) })));
}

export function prTitleReadError(error: unknown): UnexpectedError {
	return new UnexpectedError({
		cause: `${PR_TITLE_FILE_NAME}: ${unknownToMessage(error)}`,
	});
}

function generateConfig(config: RunAutoPrConfigService, branch: string) {
	const common = {
		defaultBranch: config.defaultBranch,
		branch,
		workspace: config.workspace,
		templatePath: config.templatePath,
		provider: config.provider,
		model: config.model,
		...(config.existingPrTitle !== undefined ? { existingPrTitle: config.existingPrTitle } : {}),
	};
	return config.provider === "github-models"
		? common
		: {
				...common,
				openaiCompatUrl: config.openaiCompatUrl,
				...(config.openaiCompatApiKey !== undefined
					? { openaiCompatApiKey: config.openaiCompatApiKey }
					: {}),
			};
}

/**
 * Run the local auto-PR pipeline using services from the environment.
 *
 * This keeps orchestration testable: live GitHub, git, AI, filesystem, and path
 * implementations are provided by the CLI adapter.
 */
export function runAutoPrPipelineWithServices(config: RunAutoPrConfigService) {
	return Effect.gen(function* () {
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		const { workspace, defaultBranch } = config;
		const branchVal = yield* resolveRunAutoPrBranch(config);

		yield* Effect.log({ event: "run_auto_pr", step: "generate_content" });
		yield* runGeneratePrContentWithServices(generateConfig(config, branchVal));

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
	});
}
