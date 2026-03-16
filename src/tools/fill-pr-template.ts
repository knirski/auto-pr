/**
 * Fill PR template from conventional commit messages.
 * Shell only: Effect pipelines, CLI, I/O. Core in fill-pr-template-core.ts.
 *
 * Run: npx tsx src/tools/fill-pr-template.ts --log-file <path> --files-file <path> --template <path> --format body|title-body
 *
 * Replaces {{placeholder}} values, outputs to stdout.
 *
 * Requires --log-file, --files-file, --template, --format.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Console, Effect, FileSystem, Layer, Logger, Option, type Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import {
	type FileSystemError,
	FillPrTemplate,
	FillPrTemplateConfig,
	FillPrTemplateConfigLayer,
	type FillPrTemplateParams,
	formatError,
	mapFsError,
	type ParseError,
	type PullRequestBodyBlankError,
	type PullRequestTitleBlankError,
	type TemplateRenderError,
} from "#auto-pr";
import {
	filterMergeCommits,
	formatTitleBody,
	getDescriptionPromptText,
	isValidConventionalTitle,
	parseCommits,
} from "#lib/fill-pr-template-core.js";
import pkg from "../../package.json" with { type: "json" };

// ─── Shell (Effect) ────────────────────────────────────────────────────────

type OutputFormat = "body" | "title-body";

/** Run fill using FillPrTemplate service. */
export function runFillBody(
	logFilePath: string,
	filesFilePath: string,
	templatePath: string,
	format: OutputFormat,
	howToTestDefault: string,
	descriptionFilePath?: string,
): Effect.Effect<
	string,
	| Error
	| FileSystemError
	| ParseError
	| PullRequestBodyBlankError
	| PullRequestTitleBlankError
	| TemplateRenderError,
	FileSystem.FileSystem | FillPrTemplate | Path.Path
> {
	const params = {
		logFilePath,
		filesFilePath,
		templatePath,
		howToTestDefault,
		...(descriptionFilePath !== undefined && { descriptionFilePath }),
	} satisfies FillPrTemplateParams;
	return Effect.gen(function* () {
		const fillPr = yield* FillPrTemplate;
		if (format === "body") {
			return yield* fillPr.getBody(params);
		}
		const title = yield* fillPr.getTitle(params);
		const body = yield* fillPr.getBody(params);
		return formatTitleBody(title, body);
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
	Flag.withDescription("Path to template file (e.g. .github/PULL_REQUEST_TEMPLATE.md). Required."),
);

const formatFlag = Flag.string("format").pipe(
	Flag.optional,
	Flag.withDescription("Output format: 'body' or 'title-body' (first line = PR title). Required."),
);

const quietFlag = Flag.boolean("quiet").pipe(
	Flag.optional,
	Flag.withDescription("Suppress logs (for CI when capturing stdout)."),
);

const validateTitleFlag = Flag.string("validate-title").pipe(
	Flag.optional,
	Flag.withDescription(
		"Validate conventional commit title; exit 0 if valid, 1 otherwise. Skips fill when used.",
	),
);

const outputDescriptionPromptFlag = Flag.boolean("output-description-prompt").pipe(
	Flag.optional,
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

/** Validate conventional commit title. Exported for testing. */
export function handleValidateTitle(title: string): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const valid = isValidConventionalTitle(title);
		if (!valid) yield* Effect.fail(new Error("Invalid conventional commit title"));
	});
}

/** Output description prompt from log file. Exported for testing. */
export function handleOutputDescriptionPrompt(
	logPath: string,
	quiet: boolean,
): Effect.Effect<void, Error, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const loggerLayer = quiet
			? Logger.layer([])
			: Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === undefined })]).pipe(
					Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
				);
		const layer = NodeServices.layer.pipe(Layer.provideMerge(loggerLayer));
		const output = yield* Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem.asEffect();
			const logContent = yield* fs
				.readFileString(logPath)
				.pipe(mapFsError(logPath, "readFileString"));
			const parseResult = parseCommits(logContent);
			const rawCommits = yield* Effect.fromResult(parseResult);
			const commits = filterMergeCommits(rawCommits);
			return getDescriptionPromptText(commits);
		}).pipe(Effect.provide(layer));
		yield* Console.log(output);
	});
}

function handleFill(
	logPath: string,
	filesPath: string,
	templatePath: string,
	format: OutputFormat,
	quiet: boolean,
	descriptionFile: Option.Option<string>,
) {
	return Effect.gen(function* () {
		const loggerLayer = quiet
			? Logger.layer([])
			: Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === undefined })]).pipe(
					Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
				);
		const layer = Layer.mergeAll(
			NodeServices.layer,
			NodePath.layer,
			loggerLayer,
			FillPrTemplate.Live,
			FillPrTemplateConfigLayer,
		);
		const { howToTestDefault: howToTest } = yield* FillPrTemplateConfig;
		const output = yield* runFillBody(
			logPath,
			filesPath,
			templatePath,
			format,
			howToTest,
			Option.getOrUndefined(descriptionFile),
		).pipe(Effect.provide(layer));
		yield* Console.log(output);
	});
}

/** Fill command for CLI. Exported for testing. */
export const fillCommand = Command.make(
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
	Effect.fn("fill-pr-template.handler")(function* ({
		logFile,
		filesFile,
		template,
		format,
		quiet,
		validateTitle,
		outputDescriptionPrompt,
		descriptionFile,
	}) {
		const titleToValidate = Option.getOrUndefined(validateTitle);
		if (titleToValidate !== undefined) {
			yield* handleValidateTitle(titleToValidate);
			return;
		}
		const logFilePath = Option.getOrUndefined(logFile);
		const filesFilePath = Option.getOrUndefined(filesFile);
		const quietVal = Option.getOrElse(quiet, () => false);
		const outputDescriptionPromptVal = Option.getOrElse(outputDescriptionPrompt, () => false);

		if (outputDescriptionPromptVal) {
			const logPath = yield* logFilePath
				? Effect.succeed(logFilePath)
				: Effect.fail(new Error("--output-description-prompt requires --log-file."));
			yield* handleOutputDescriptionPrompt(logPath, quietVal);
			return;
		}

		const templatePath = yield* Option.match(template, {
			onNone: () => Effect.fail(new Error("--template is required")),
			onSome: (t) => Effect.succeed(t),
		});
		const formatVal = yield* Option.match(format, {
			onNone: () => Effect.fail(new Error("--format is required")),
			onSome: (f) =>
				f === "body" || f === "title-body"
					? Effect.succeed(f as OutputFormat)
					: Effect.fail(new Error("--format must be 'body' or 'title-body'")),
		});

		const logPath = yield* logFilePath
			? Effect.succeed(logFilePath)
			: Effect.fail(
					new Error(
						"--log-file and --files-file are required. Generate them via git before invoking.",
					),
				);
		const filesPath = yield* filesFilePath
			? Effect.succeed(filesFilePath)
			: Effect.fail(
					new Error(
						"--log-file and --files-file are required. Generate them via git before invoking.",
					),
				);
		yield* handleFill(logPath, filesPath, templatePath, formatVal, quietVal, descriptionFile);
	}),
);

const cliProgram = Command.run(fillCommand, { version: pkg.version });

const LoggerLayer = Logger.layer([
	Logger.consolePretty({ colors: process.env.NO_COLOR === undefined }),
]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));

/** CLI layer (NodeServices + Logger + FillPrTemplateConfig). Exported for tests. */
export const CliLayer = NodeServices.layer.pipe(
	Layer.provideMerge(LoggerLayer),
	Layer.provideMerge(FillPrTemplateConfigLayer),
);

if (import.meta.main) {
	NodeRuntime.runMain(
		cliProgram.pipe(
			Effect.provide(CliLayer),
			Effect.tapError((e) =>
				Effect.logError({
					event: "fill_pr_template_failed",
					error: formatError(e),
					...(e instanceof Error && e.stack ? { stack: e.stack } : {}),
				}),
			),
		),
	);
}
