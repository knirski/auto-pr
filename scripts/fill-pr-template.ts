/**
 * Fill PR template from conventional commit messages.
 * Shell only: Effect pipelines, CLI, I/O. Core in fill-pr-template-core.ts.
 *
 * Run: npx tsx scripts/fill-pr-template.ts --log-file <path> --files-file <path>
 *
 * Reads .github/PULL_REQUEST_TEMPLATE.md (or --template path), replaces
 * {{placeholder}} values, outputs to stdout.
 *
 * Requires --log-file and --files-file (commit log and changed files).
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Console, Effect, FileSystem, Layer, Logger, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { ParseError } from "./auto-pr/errors.js";
import {
	FillPrTemplate,
	FillPrTemplateLiveLayer,
	formatAutoPrError,
	type PrTitleBlank,
} from "./auto-pr/index.js";
import type { FillPrTemplateParams } from "./auto-pr/interfaces/fill-pr-template.js";
import type { FileSystemError } from "./auto-pr/utils.js";
import { mapFsError } from "./auto-pr/utils.js";
import {
	filterMergeCommits,
	getDescriptionPromptText,
	isValidConventionalTitle,
	parseCommits,
	renderBody as renderBodyCore,
} from "./fill-pr-template-core.js";

// Re-export core for consumers (tests, generate-pr-content, live interpreter)
export {
	fillTemplate,
	filterMergeCommits,
	getBreakingChanges,
	getChanges,
	getDescription,
	getDescriptionFromCommits,
	getDescriptionPromptText,
	getRelatedIssues,
	hasDocsFiles,
	hasTestFiles,
	inferTypeOfChange,
	isConventional,
	isDocsOnly,
	isMergeCommit,
	isValidConventionalTitle,
	parseCommits,
	renderFromTemplate,
} from "./fill-pr-template-core.js";
export { ParseError };

// ─── Shell (Effect) ────────────────────────────────────────────────────────

type OutputFormat = "body" | "title-body";

/** Effect wrapper: calls pure renderBody, logs if unreplaced placeholders remain. */
export function renderBody(
	commits: Parameters<typeof renderBodyCore>[0],
	files: Parameters<typeof renderBodyCore>[1],
	template: Parameters<typeof renderBodyCore>[2],
	descriptionOverride?: Parameters<typeof renderBodyCore>[3],
	howToTestDefault?: Parameters<typeof renderBodyCore>[4],
): Effect.Effect<string> {
	const body = renderBodyCore(commits, files, template, descriptionOverride, howToTestDefault);
	return body.includes("{{")
		? Effect.gen(function* () {
				yield* Effect.logWarning({
					event: "fill_pr_template",
					message: "Output contains unreplaced {{placeholder}}s",
				});
				return body;
			})
		: Effect.succeed(body);
}

/** Run fill using FillPrTemplate service. */
export function runFillBody(
	logFilePath: string,
	filesFilePath: string,
	templatePath: string | undefined,
	format: OutputFormat = "body",
	descriptionFilePath?: string,
): Effect.Effect<
	string,
	ParseError | FileSystemError | PrTitleBlank,
	FileSystem.FileSystem | FillPrTemplate | import("effect").Path.Path
> {
	const howToTestDefault = process.env.AUTO_PR_HOW_TO_TEST ?? undefined;
	const params = {
		logFilePath,
		filesFilePath,
		...(templatePath !== undefined && { templatePath }),
		...(descriptionFilePath !== undefined && { descriptionFilePath }),
		...(howToTestDefault !== undefined && { howToTestDefault }),
	} satisfies FillPrTemplateParams;
	return Effect.gen(function* () {
		const fillPr = yield* FillPrTemplate;
		if (format === "body") {
			return yield* fillPr.getBody(params);
		}
		const title = yield* fillPr.getTitle(params);
		const body = yield* fillPr.getBody(params);
		return `${title}\n\n${body}`;
	});
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const logFileFlag = Flag.string("log-file").pipe(
	Flag.optional,
	Flag.withDescription("Path to file containing commit log (---COMMIT--- separated blocks)."),
);

const filesFileFlag = Flag.string("files-file").pipe(
	Flag.optional,
	Flag.withDescription("Path to file containing newline-separated changed file names."),
);

const templateFlag = Flag.string("template").pipe(
	Flag.optional,
	Flag.withDescription("Path to template file (default: .github/PULL_REQUEST_TEMPLATE.md)"),
);

const formatFlag = Flag.string("format").pipe(
	Flag.optional,
	Flag.withDescription("Output format: 'body' (default) or 'title-body' (first line = PR title)."),
);

const quietFlag = Flag.boolean("quiet").pipe(
	Flag.withDefault(false),
	Flag.withDescription("Suppress logs (for CI when capturing stdout)."),
);

const validateTitleFlag = Flag.string("validate-title").pipe(
	Flag.optional,
	Flag.withDescription(
		"Validate conventional commit title; exit 0 if valid, 1 otherwise. Skips fill when used.",
	),
);

const outputDescriptionPromptFlag = Flag.boolean("output-description-prompt").pipe(
	Flag.withDefault(false),
	Flag.withDescription(
		"Output commit content for Ollama to summarize into PR description. Requires --log-file only. Exits after output.",
	),
);

const descriptionFileFlag = Flag.string("description-file").pipe(
	Flag.optional,
	Flag.withDescription(
		"Path to file containing Ollama-generated description. Overrides computed description.",
	),
);

const fillCommand = Command.make(
	"fill-pr-template",
	{
		logFile: logFileFlag,
		filesFile: filesFileFlag,
		template: templateFlag,
		format: formatFlag,
		quiet: quietFlag,
		validateTitle: validateTitleFlag,
		outputDescriptionPrompt: outputDescriptionPromptFlag,
		descriptionFile: descriptionFileFlag,
	},
	({
		logFile,
		filesFile,
		template,
		format,
		quiet,
		validateTitle,
		outputDescriptionPrompt,
		descriptionFile,
	}) => {
		const titleToValidate = Option.getOrUndefined(validateTitle);
		if (titleToValidate !== undefined) {
			const valid = isValidConventionalTitle(titleToValidate);
			return Effect.sync(() => {
				process.exit(valid ? 0 : 1);
			});
		}
		const logFilePath = Option.getOrUndefined(logFile);
		const filesFilePath = Option.getOrUndefined(filesFile);

		if (outputDescriptionPrompt) {
			if (!logFilePath) {
				return Effect.fail(new Error("--output-description-prompt requires --log-file."));
			}
			const loggerLayer = quiet
				? Logger.layer([])
				: Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === undefined })]).pipe(
						Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
					);
			const layer = NodeServices.layer.pipe(Layer.provideMerge(loggerLayer));
			return Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem.asEffect();
				const logContent = yield* fs
					.readFileString(logFilePath)
					.pipe(mapFsError(logFilePath, "readFileString"));
				const parseResult = parseCommits(logContent);
				const rawCommits = yield* Effect.fromResult(parseResult);
				const commits = filterMergeCommits(rawCommits);
				return getDescriptionPromptText(commits);
			}).pipe(Effect.provide(layer), Effect.flatMap(Console.log));
		}

		if (!logFilePath || !filesFilePath) {
			return Effect.fail(
				new Error(
					"--log-file and --files-file are required. Generate them via git before invoking.",
				),
			);
		}
		const formatVal = Option.getOrUndefined(format) === "title-body" ? "title-body" : "body";
		const loggerLayer = quiet
			? Logger.layer([])
			: Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === undefined })]).pipe(
					Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
				);
		const layer = Layer.mergeAll(
			NodeServices.layer,
			NodePath.layer,
			loggerLayer,
			FillPrTemplateLiveLayer,
		);
		return runFillBody(
			logFilePath,
			filesFilePath,
			Option.getOrUndefined(template),
			formatVal,
			Option.getOrUndefined(descriptionFile),
		).pipe(Effect.provide(layer), Effect.flatMap(Console.log));
	},
);

const cliProgram = Command.run(fillCommand, { version: pkg.version });

const LoggerLayer = Logger.layer([
	Logger.consolePretty({ colors: process.env.NO_COLOR === undefined }),
]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));

const CliLayer = NodeServices.layer.pipe(Layer.provideMerge(LoggerLayer));

if (import.meta.main) {
	NodeRuntime.runMain(
		cliProgram.pipe(
			Effect.provide(CliLayer),
			Effect.tapError((e) =>
				Effect.logError({
					event: "fill_pr_template_failed",
					error: formatAutoPrError(e),
					...(e instanceof Error && e.stack ? { stack: e.stack } : {}),
				}),
			),
		),
	);
}
