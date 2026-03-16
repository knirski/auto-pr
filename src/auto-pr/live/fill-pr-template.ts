/**
 * Live FillPrTemplate interpreter. Uses fill-pr-template core, FileSystem, and Path.
 */

import { Effect, FileSystem, Layer, Path, pipe, ServiceMap } from "effect";
import {
	FillPrTemplateValidationError,
	type ParseError,
	PullRequestBodyBlankError,
	PullRequestTitleBlankError,
} from "#auto-pr/errors.js";
import type {
	FillPrTemplateParams,
	FillPrTemplateService,
} from "#auto-pr/interfaces/fill-pr-template.js";
import type { FileSystemError } from "#auto-pr/utils.js";
import { mapFsError, redactPath } from "#auto-pr/utils.js";
import type { CommitInfo } from "#lib/fill-pr-template-core.js";
import {
	filterMergeCommits,
	getTitle as getTitleFromCommits,
	hasUnreplacedPlaceholders,
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
} from "#lib/fill-pr-template-core.js";

/** Effect wrapper: calls pure renderBody, logs if unreplaced placeholders remain. */
export const renderBody = Effect.fn("renderBody")(function* (
	commits: Parameters<typeof renderBodyCore>[0],
	files: Parameters<typeof renderBodyCore>[1],
	template: Parameters<typeof renderBodyCore>[2],
	descriptionOverride?: Parameters<typeof renderBodyCore>[3],
	howToTestDefault?: Parameters<typeof renderBodyCore>[4],
) {
	const bodyResult = renderBodyCore(
		commits,
		files,
		template,
		descriptionOverride,
		howToTestDefault,
	);
	const body = yield* Effect.fromResult(bodyResult);
	return hasUnreplacedPlaceholders(body)
		? yield* Effect.gen(function* () {
				yield* Effect.logWarning({
					event: "fill_pr_template",
					message: "Output contains unreplaced {{placeholder}}s",
				});
				return body;
			})
		: body;
});

/** Resolve template path. Requires templatePath (no default). */
function resolveTemplatePath(pathApi: Path.Path, cwd: string, templatePath: string): string {
	return pathApi.isAbsolute(templatePath) ? templatePath : pathApi.resolve(cwd, templatePath);
}

function readTemplate(
	filePath: string,
): Effect.Effect<string, FileSystemError, FileSystem.FileSystem> {
	return pipe(
		FileSystem.FileSystem.asEffect(),
		Effect.flatMap((fs) =>
			fs.readFileString(filePath).pipe(mapFsError(filePath, "readFileString")),
		),
	);
}

function readLogAndFiles(
	logFilePath: string,
	filesFilePath: string,
): Effect.Effect<readonly [string, readonly string[]], FileSystemError, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem.asEffect();
		const [logContent, filesContent] = yield* Effect.all([
			fs.readFileString(logFilePath).pipe(mapFsError(logFilePath, "readFileString")),
			fs.readFileString(filesFilePath).pipe(mapFsError(filesFilePath, "readFileString")),
		]);
		const files = parseFilesContent(filesContent);
		return [logContent, files] as const;
	});
}

type LoadedTemplateParams = {
	readonly template: string;
	readonly commits: readonly CommitInfo[];
	readonly files: readonly string[];
	readonly descriptionOverride: string | undefined;
	readonly howToTestDefault: string | undefined;
};

function loadTemplateAndParams(
	params: FillPrTemplateParams,
): Effect.Effect<
	LoadedTemplateParams,
	FileSystemError | FillPrTemplateValidationError | ParseError,
	FileSystem.FileSystem | Path.Path
> {
	return Effect.gen(function* () {
		if (params.templatePath === undefined || params.templatePath.trim() === "") {
			return yield* Effect.fail(
				new FillPrTemplateValidationError({ message: "templatePath is required" }),
			);
		}
		const pathApi = yield* Path.Path;
		const cwd = yield* Effect.sync(() => process.cwd());
		const resolvedPath = resolveTemplatePath(pathApi, cwd, params.templatePath);

		const template = yield* readTemplate(resolvedPath);
		const [logContent, files] = yield* readLogAndFiles(params.logFilePath, params.filesFilePath);
		const parseResult = parseCommits(logContent);
		const rawCommits = yield* Effect.fromResult(parseResult);
		const commits = filterMergeCommits(rawCommits);

		let descriptionOverride: string | undefined;
		if (params.descriptionFilePath) {
			const fs = yield* FileSystem.FileSystem.asEffect();
			descriptionOverride = yield* fs
				.readFileString(params.descriptionFilePath)
				.pipe(mapFsError(params.descriptionFilePath, "readFileString"));
		}

		return {
			template,
			commits,
			files,
			descriptionOverride,
			howToTestDefault: params.howToTestDefault,
		};
	});
}

/** FillPrTemplate service tag. */
export class FillPrTemplate extends ServiceMap.Service<FillPrTemplate, FillPrTemplateService>()(
	"auto-pr/fill-pr-template",
) {
	/** Live layer for FillPrTemplate. No dependencies. */
	static readonly Live: Layer.Layer<FillPrTemplate, never> = Layer.effect(
		FillPrTemplate,
		Effect.gen(function* () {
			const getTitle = Effect.fn("FillPrTemplate.getTitle")(function* (
				params: FillPrTemplateParams,
			) {
				yield* Effect.log({
					event: "fill_pr_template",
					status: "getTitle",
					logFile: redactPath(params.logFilePath),
					filesFile: redactPath(params.filesFilePath),
				});
				const [logContent, _files] = yield* readLogAndFiles(
					params.logFilePath,
					params.filesFilePath,
				);
				const parseResult = parseCommits(logContent);
				const rawCommits = yield* Effect.fromResult(parseResult);
				const commits = filterMergeCommits(rawCommits);
				const title = getTitleFromCommits(commits);
				if (!title.trim()) {
					return yield* Effect.fail(
						new PullRequestTitleBlankError({
							message:
								"PR title is empty. Add at least one non-merge commit with non-empty subject (e.g. feat: add X) before pushing.",
						}),
					);
				}
				return title;
			});

			const getBody = Effect.fn("FillPrTemplate.getBody")(function* (params: FillPrTemplateParams) {
				if (params.templatePath === undefined || params.templatePath.trim() === "") {
					return yield* Effect.fail(
						new FillPrTemplateValidationError({ message: "templatePath is required" }),
					);
				}
				const pathApi = yield* Path.Path;
				const cwd = yield* Effect.sync(() => process.cwd());
				const resolvedPath = resolveTemplatePath(pathApi, cwd, params.templatePath);
				yield* Effect.log({
					event: "fill_pr_template",
					status: "getBody",
					logFile: redactPath(params.logFilePath),
					filesFile: redactPath(params.filesFilePath),
					templatePath: redactPath(resolvedPath),
				});

				const { template, commits, files, descriptionOverride, howToTestDefault } =
					yield* loadTemplateAndParams(params);

				const body = yield* renderBody(
					commits,
					files,
					template,
					descriptionOverride,
					howToTestDefault,
				);
				if (!body.trim()) {
					return yield* Effect.fail(
						new PullRequestBodyBlankError({
							message:
								"PR body is empty. Add at least one non-merge commit with a non-empty body before pushing.",
						}),
					);
				}
				yield* Effect.log({
					event: "fill_pr_template",
					status: "getBody_succeeded",
					commitsCount: commits.length,
					filesCount: files.length,
				});
				return body;
			});

			return FillPrTemplate.of({ getTitle, getBody });
		}),
	);
}
