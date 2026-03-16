#!/usr/bin/env node

import { B as NoSemanticCommitsError, E as trimOllamaResponse, N as GeneratePrContentConfig, P as GeneratePrContentConfigLayer, S as isHttpError, T as parseTitleDescriptionResponse, V as OllamaHttpError, _ as renderBody, d as getDescriptionFromCommits, f as getDescriptionPromptText, g as parseFilesContent, h as parseCommits, i as appendGhOutput, l as filterMergeCommits, m as isValidConventionalTitle, o as runMain, p as getTitle, r as PlatformLayer, s as getPrDescriptionPromptPath, v as buildDescriptionPrompt, y as buildGenerateContentGhEntries } from "../auto-pr-gJsKsYcH.mjs";
import { Duration, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import * as Http from "effect/unstable/http";
//#region src/workflow/generate-pr-content.ts
/**
* Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
*
* Requires env: COMMITS (path), FILES (path), GITHUB_OUTPUT, GITHUB_WORKSPACE,
* PR_TEMPLATE_PATH, OLLAMA_MODEL, OLLAMA_URL (for 2+ commits)
* Requires env: AUTO_PR_HOW_TO_TEST
*
* Parses commits to count semantic commits. For 1: FillPrTemplate only.
* For 2+: Ollama generates title and description, then FillPrTemplate with override.
*
* Outputs to GITHUB_OUTPUT: title, body_file (path to filled template)
*
* Run: npx tsx src/workflow/generate-pr-content.ts (or: node dist/workflow/auto-pr-generate-pr-content.mjs)
*/
const BODY_FILE_NAME = "pr-body.md";
const MAX_OLLAMA_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3e3;
const OllamaResponseSchema = Schema.Struct({ response: Schema.optional(Schema.String) });
function callOllama(ollamaUrl, model, prompt) {
	return Effect.gen(function* () {
		const client = yield* Http.HttpClient.HttpClient;
		const req = Http.HttpClientRequest.post(ollamaUrl, { body: Http.HttpBody.jsonUnsafe({
			model,
			prompt,
			stream: false
		}) });
		const raw = yield* (yield* client.execute(req).pipe(Effect.flatMap((r) => isHttpError(r.status) ? Effect.fail(new OllamaHttpError({
			status: r.status,
			cause: `HTTP ${r.status}`
		})) : Effect.succeed(r)))).json;
		const response = (yield* Schema.decodeUnknownEffect(OllamaResponseSchema)(raw).pipe(Effect.mapError((e) => new OllamaHttpError({ cause: `response: ${String(e)}` })))).response;
		if (response === void 0 || response.trim() === "") return yield* Effect.fail(new OllamaHttpError({ cause: "Ollama response is absent or empty" }));
		return trimOllamaResponse(response);
	});
}
function makeRetrySchedule(delayMs) {
	return Schedule.recurs(MAX_OLLAMA_ATTEMPTS - 1).pipe(Schedule.addDelay(() => Effect.logWarning({
		event: "generate_pr_content",
		status: "ollama_retry",
		message: "Title invalid or Ollama failed, retrying in 3s..."
	}).pipe(Effect.as(Duration.millis(delayMs)))));
}
function getFallbackTitleAndDescription(filtered) {
	const firstSubject = filtered[0]?.subject?.trim() ?? "";
	return {
		title: isValidConventionalTitle(firstSubject) ? firstSubject : "chore: update",
		description: getDescriptionFromCommits(filtered)
	};
}
function generateTitleAndDescription(ollamaUrl, model, prompt, filtered, retryDelayMs = RETRY_DELAY_MS) {
	return callOllama(ollamaUrl, model, prompt).pipe(Effect.flatMap((raw) => Effect.fromResult(parseTitleDescriptionResponse(raw))), Effect.flatMap(({ title, description }) => isValidConventionalTitle(title) ? Effect.succeed({
		title,
		description
	}) : Effect.fail(/* @__PURE__ */ new Error(`Title not in conventional format: "${title}"`)))).pipe(Effect.retry(makeRetrySchedule(retryDelayMs)), Effect.catch(() => Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(Effect.tap(() => Effect.logWarning({
		event: "generate_pr_content",
		status: "fallback",
		message: "Using fallback title after 5 invalid attempts"
	})))));
}
/**
* Generate PR title and body from content. No file I/O.
* Use for tests or when content is already in memory.
*/
function generatePrContentFromValues(params) {
	return Effect.gen(function* () {
		const { commitsContent, filesContent, templateContent, descriptionPromptText, howToTestDefault, model, ollamaUrl, retryDelayMs } = params;
		const parseResult = parseCommits(commitsContent);
		const filtered = filterMergeCommits(yield* Effect.fromResult(parseResult));
		const count = filtered.length;
		if (count === 0) return yield* Effect.fail(new NoSemanticCommitsError({ message: "No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing." }));
		const files = parseFilesContent(filesContent);
		let title;
		let descriptionOverride;
		if (count >= 2) {
			const result = yield* generateTitleAndDescription(ollamaUrl, model, buildDescriptionPrompt(descriptionPromptText, getDescriptionPromptText(filtered)), filtered, retryDelayMs ?? RETRY_DELAY_MS);
			title = result.title;
			descriptionOverride = result.description;
		} else {
			title = getTitle(filtered);
			descriptionOverride = void 0;
		}
		const bodyResult = renderBody(filtered, files, templateContent, descriptionOverride, howToTestDefault);
		const body = yield* Effect.fromResult(bodyResult);
		return {
			title,
			body,
			count
		};
	});
}
function runGeneratePrContent(config) {
	return Effect.gen(function* () {
		const { commits, files, ghOutput, workspace, templatePath, model, ollamaUrl, howToTestDefault, retryDelayMs } = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		const [commitsContent, filesContent, templateContent, descriptionPromptText] = yield* Effect.all([
			fs.readFileString(commits).pipe(Effect.mapError((e) => /* @__PURE__ */ new Error(`commits: ${String(e)}`))),
			fs.readFileString(files).pipe(Effect.mapError((e) => /* @__PURE__ */ new Error(`files: ${String(e)}`))),
			fs.readFileString(templatePath).pipe(Effect.mapError((e) => /* @__PURE__ */ new Error(`template: ${String(e)}`))),
			getPrDescriptionPromptPath().pipe(Effect.flatMap((p) => fs.readFileString(p).pipe(Effect.mapError((e) => /* @__PURE__ */ new Error(`pr-description.txt: ${String(e)}`)))))
		]);
		const { title, body, count } = yield* generatePrContentFromValues({
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			howToTestDefault,
			model,
			ollamaUrl,
			...retryDelayMs !== void 0 && { retryDelayMs }
		});
		const bodyPath = pathApi.join(workspace, BODY_FILE_NAME);
		yield* fs.writeFileString(bodyPath, body).pipe(Effect.mapError((e) => /* @__PURE__ */ new Error(`write body: ${String(e)}`)));
		const entriesResult = buildGenerateContentGhEntries(title, bodyPath);
		yield* appendGhOutput(ghOutput, yield* Effect.fromResult(entriesResult));
		yield* Effect.log({
			event: "generate_pr_content",
			status: "success",
			count,
			mode: count >= 2 ? "ollama" : "single_commit"
		});
	});
}
const GeneratePrContentLayer = Layer.mergeAll(PlatformLayer, Http.FetchHttpClient.layer);
const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	yield* runGeneratePrContent({
		commits: config.commits,
		files: config.files,
		ghOutput: config.ghOutput,
		workspace: config.workspace,
		templatePath: config.templatePath,
		model: config.model,
		ollamaUrl: config.ollamaUrl,
		howToTestDefault: config.howToTestDefault
	}).pipe(Effect.provide(GeneratePrContentLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));
if (import.meta.main) runMain(program, "generate_pr_content_failed");
//#endregion
export { generatePrContentFromValues, runGeneratePrContent };

//# sourceMappingURL=auto-pr-generate-content.mjs.map