#!/usr/bin/env node

import { H as formatError, M as FillPrTemplateConfigLayer, U as mapFsError, c as FillPrTemplate, f as getDescriptionPromptText, h as parseCommits, j as FillPrTemplateConfig, l as filterMergeCommits, m as isValidConventionalTitle, u as formatTitleBody } from "../auto-pr-gJsKsYcH.mjs";
import { Console, Effect, FileSystem, Layer, Logger, Option } from "effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Command, Flag } from "effect/unstable/cli";
//#region package.json
var version = "0.1.0";
//#endregion
//#region src/tools/fill-pr-template.ts
/**
* Fill PR template from conventional commit messages.
* Shell only: Effect pipelines, CLI, I/O. Core in fill-pr-template-core.ts.
*
* Run: npx tsx src/tools/fill-pr-template.ts (or: node dist/tools/fill-pr-template.mjs) --log-file <path> --files-file <path> --template <path> --format body|title-body
*
* Replaces {{placeholder}} values, outputs to stdout.
*
* Requires --log-file, --files-file, --template, --format.
*/
/** Run fill using FillPrTemplate service. */
function runFillBody(logFilePath, filesFilePath, templatePath, format, howToTestDefault, descriptionFilePath) {
	const params = {
		logFilePath,
		filesFilePath,
		templatePath,
		howToTestDefault,
		...descriptionFilePath !== void 0 && { descriptionFilePath }
	};
	return Effect.gen(function* () {
		const fillPr = yield* FillPrTemplate;
		if (format === "body") return yield* fillPr.getBody(params);
		return formatTitleBody(yield* fillPr.getTitle(params), yield* fillPr.getBody(params));
	});
}
const logFileFlag = Flag.string("log-file").pipe(Flag.optional, Flag.withDescription("Path to file containing commit log (---COMMIT--- separated blocks)."));
const filesFileFlag = Flag.string("files-file").pipe(Flag.optional, Flag.withDescription("Path to file containing newline-separated changed file names."));
const templateFlag = Flag.string("template").pipe(Flag.optional, Flag.withDescription("Path to template file (e.g. .github/PULL_REQUEST_TEMPLATE.md). Required."));
const formatFlag = Flag.string("format").pipe(Flag.optional, Flag.withDescription("Output format: 'body' or 'title-body' (first line = PR title). Required."));
const quietFlag = Flag.boolean("quiet").pipe(Flag.optional, Flag.withDescription("Suppress logs (for CI when capturing stdout)."));
const validateTitleFlag = Flag.string("validate-title").pipe(Flag.optional, Flag.withDescription("Validate conventional commit title; exit 0 if valid, 1 otherwise. Skips fill when used."));
const outputDescriptionPromptFlag = Flag.boolean("output-description-prompt").pipe(Flag.optional, Flag.withDescription("Output commit content for Ollama to summarize into PR description. Requires --log-file only. Exits after output."));
const descriptionFileFlag = Flag.string("description-file").pipe(Flag.optional, Flag.withDescription("Path to file containing Ollama-generated description. Overrides computed description."));
/** Validate conventional commit title. Exported for testing. */
function handleValidateTitle(title) {
	return Effect.gen(function* () {
		if (!isValidConventionalTitle(title)) yield* Effect.fail(/* @__PURE__ */ new Error("Invalid conventional commit title"));
	});
}
/** Output description prompt from log file. Exported for testing. */
function handleOutputDescriptionPrompt(logPath, quiet) {
	return Effect.gen(function* () {
		const loggerLayer = quiet ? Logger.layer([]) : Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === void 0 })]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));
		const layer = NodeServices.layer.pipe(Layer.provideMerge(loggerLayer));
		const output = yield* Effect.gen(function* () {
			const parseResult = parseCommits(yield* (yield* FileSystem.FileSystem.asEffect()).readFileString(logPath).pipe(mapFsError(logPath, "readFileString")));
			return getDescriptionPromptText(filterMergeCommits(yield* Effect.fromResult(parseResult)));
		}).pipe(Effect.provide(layer));
		yield* Console.log(output);
	});
}
function handleFill(logPath, filesPath, templatePath, format, quiet, descriptionFile) {
	return Effect.gen(function* () {
		const loggerLayer = quiet ? Logger.layer([]) : Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === void 0 })]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));
		const layer = Layer.mergeAll(NodeServices.layer, NodePath.layer, loggerLayer, FillPrTemplate.Live, FillPrTemplateConfigLayer);
		const { howToTestDefault: howToTest } = yield* FillPrTemplateConfig;
		const output = yield* runFillBody(logPath, filesPath, templatePath, format, howToTest, Option.getOrUndefined(descriptionFile)).pipe(Effect.provide(layer));
		yield* Console.log(output);
	});
}
/** Fill command for CLI. Exported for testing. */
const fillCommand = Command.make("fill-pr-template", {
	logFile: logFileFlag,
	filesFile: filesFileFlag,
	template: templateFlag,
	format: formatFlag,
	quiet: quietFlag,
	validateTitle: validateTitleFlag,
	outputDescriptionPrompt: outputDescriptionPromptFlag,
	descriptionFile: descriptionFileFlag
}, Effect.fn("fill-pr-template.handler")(function* ({ logFile, filesFile, template, format, quiet, validateTitle, outputDescriptionPrompt, descriptionFile }) {
	const titleToValidate = Option.getOrUndefined(validateTitle);
	if (titleToValidate !== void 0) {
		yield* handleValidateTitle(titleToValidate);
		return;
	}
	const logFilePath = Option.getOrUndefined(logFile);
	const filesFilePath = Option.getOrUndefined(filesFile);
	const quietVal = Option.getOrElse(quiet, () => false);
	if (Option.getOrElse(outputDescriptionPrompt, () => false)) {
		yield* handleOutputDescriptionPrompt(yield* logFilePath ? Effect.succeed(logFilePath) : Effect.fail(/* @__PURE__ */ new Error("--output-description-prompt requires --log-file.")), quietVal);
		return;
	}
	const templatePath = yield* Option.match(template, {
		onNone: () => Effect.fail(/* @__PURE__ */ new Error("--template is required")),
		onSome: (t) => Effect.succeed(t)
	});
	const formatVal = yield* Option.match(format, {
		onNone: () => Effect.fail(/* @__PURE__ */ new Error("--format is required")),
		onSome: (f) => f === "body" || f === "title-body" ? Effect.succeed(f) : Effect.fail(/* @__PURE__ */ new Error("--format must be 'body' or 'title-body'"))
	});
	yield* handleFill(yield* logFilePath ? Effect.succeed(logFilePath) : Effect.fail(/* @__PURE__ */ new Error("--log-file and --files-file are required. Generate them via git before invoking.")), yield* filesFilePath ? Effect.succeed(filesFilePath) : Effect.fail(/* @__PURE__ */ new Error("--log-file and --files-file are required. Generate them via git before invoking.")), templatePath, formatVal, quietVal, descriptionFile);
}));
const cliProgram = Command.run(fillCommand, { version });
const LoggerLayer = Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === void 0 })]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));
/** CLI layer (NodeServices + Logger + FillPrTemplateConfig). Exported for tests. */
const CliLayer = NodeServices.layer.pipe(Layer.provideMerge(LoggerLayer), Layer.provideMerge(FillPrTemplateConfigLayer));
if (import.meta.main) NodeRuntime.runMain(cliProgram.pipe(Effect.provide(CliLayer), Effect.tapError((e) => Effect.logError({
	event: "fill_pr_template_failed",
	error: formatError(e),
	...e instanceof Error && e.stack ? { stack: e.stack } : {}
}))));
//#endregion
export { CliLayer, fillCommand, handleOutputDescriptionPrompt, handleValidateTitle, runFillBody };

//# sourceMappingURL=fill-pr-template.mjs.map