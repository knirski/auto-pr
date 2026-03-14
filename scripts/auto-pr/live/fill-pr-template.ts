/**
 * Live FillPrTemplate interpreter. Uses fill-pr-template core, FileSystem, and Path.
 */

import { Effect, FileSystem, Layer, Path, pipe, ServiceMap } from "effect";
import { renderBody } from "../../fill-pr-template.js";
import { filterMergeCommits, getTitle, parseCommits } from "../../fill-pr-template-core.js";
import { PrTitleBlank } from "../errors.js";
import type {
	FillPrTemplateParams,
	FillPrTemplateService,
} from "../interfaces/fill-pr-template.js";
import { mapFsError, redactPath } from "../utils.js";

/** Resolve template path (default: .github/PULL_REQUEST_TEMPLATE.md). Uses Path service. */
function resolveTemplatePath(
	pathApi: Path.Path,
	cwd: string,
	templatePath: string | undefined,
): string {
	return templatePath
		? pathApi.isAbsolute(templatePath)
			? templatePath
			: pathApi.resolve(cwd, templatePath)
		: pathApi.resolve(cwd, ".github/PULL_REQUEST_TEMPLATE.md");
}

function readTemplate(
	filePath: string,
): Effect.Effect<string, import("../utils.js").FileSystemError, FileSystem.FileSystem> {
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
): Effect.Effect<
	readonly [string, readonly string[]],
	import("../utils.js").FileSystemError,
	FileSystem.FileSystem
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem.asEffect();
		const [logContent, filesContent] = yield* Effect.all([
			fs.readFileString(logFilePath).pipe(mapFsError(logFilePath, "readFileString")),
			fs.readFileString(filesFilePath).pipe(mapFsError(filesFilePath, "readFileString")),
		]);
		const files = filesContent
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean);
		return [logContent, files] as const;
	});
}

function createFillPrTemplateService(): FillPrTemplateService {
	return {
		getTitle: (params: FillPrTemplateParams) =>
			Effect.gen(function* () {
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
				const title = getTitle(commits);
				if (!title.trim()) {
					return yield* Effect.fail(
						new PrTitleBlank({
							message:
								"PR title is empty. Add at least one non-merge commit with non-empty subject (e.g. feat: add X) before pushing.",
						}),
					);
				}
				return title;
			}),

		getBody: (params: FillPrTemplateParams) =>
			Effect.gen(function* () {
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
				const template = yield* readTemplate(resolvedPath);
				const [logContent, files] = yield* readLogAndFiles(
					params.logFilePath,
					params.filesFilePath,
				);
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

				const howToTestDefault =
					params.howToTestDefault ?? process.env.AUTO_PR_HOW_TO_TEST ?? undefined;
				const body = yield* renderBody(
					commits,
					files,
					template,
					descriptionOverride,
					howToTestDefault,
				);
				yield* Effect.log({
					event: "fill_pr_template",
					status: "getBody_succeeded",
					commitsCount: commits.length,
					filesCount: files.length,
				});
				return body;
			}),
	};
}

/** FillPrTemplate service tag. */
export class FillPrTemplate extends ServiceMap.Service<FillPrTemplate, FillPrTemplateService>()(
	"auto-pr/fill-pr-template",
) {}

/** Live layer for FillPrTemplate. No dependencies. */
export const FillPrTemplateLiveLayer: Layer.Layer<FillPrTemplate, never> = Layer.succeed(
	FillPrTemplate,
	createFillPrTemplateService(),
);
