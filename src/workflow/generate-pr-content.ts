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
 * Run: npx tsx src/workflow/generate-pr-content.ts
 */

import { Duration, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import * as Http from "effect/unstable/http";
import {
	AutoPrPlatformLayer,
	appendGhOutput,
	buildDescriptionPrompt,
	buildGenerateContentGhEntries,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	getPrDescriptionPromptPath,
	isHttpError,
	NoSemanticCommitsError,
	OllamaHttpError,
	parseTitleDescriptionResponse,
	runMain,
	trimOllamaResponse,
} from "#auto-pr";
import type { CommitInfo } from "#lib/fill-pr-template-core.js";
import {
	filterMergeCommits,
	getDescriptionFromCommits,
	getDescriptionPromptText,
	getTitle as getTitleFromCommits,
	isValidConventionalTitle,
	parseCommits,
	parseFilesContent,
	renderBody as renderBodyCore,
} from "#lib/fill-pr-template-core.js";

// ─── Constants ────────────────────────────────────────────────────────────

const BODY_FILE_NAME = "pr-body.md";
const MAX_OLLAMA_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

const OllamaResponseSchema = Schema.Struct({
	response: Schema.optional(Schema.String),
});

// ─── Ollama (2+ commits only) ──────────────────────────────────────────────

function callOllama(
	ollamaUrl: string,
	model: string,
	prompt: string,
): Effect.Effect<string, Error, Http.HttpClient.HttpClient> {
	return Effect.gen(function* () {
		const client = yield* Http.HttpClient.HttpClient;
		const req = Http.HttpClientRequest.post(ollamaUrl, {
			body: Http.HttpBody.jsonUnsafe({ model, prompt, stream: false }),
		});
		const res = yield* client
			.execute(req)
			.pipe(
				Effect.flatMap((r) =>
					isHttpError(r.status)
						? Effect.fail(new OllamaHttpError({ status: r.status, cause: `HTTP ${r.status}` }))
						: Effect.succeed(r),
				),
			);
		const raw = yield* res.json;
		const decoded = yield* Schema.decodeUnknownEffect(OllamaResponseSchema)(raw).pipe(
			Effect.mapError((e) => new OllamaHttpError({ cause: `response: ${String(e)}` })),
		);
		const response = decoded.response;
		if (response === undefined || response.trim() === "") {
			return yield* Effect.fail(
				new OllamaHttpError({ cause: "Ollama response is absent or empty" }),
			);
		}
		return trimOllamaResponse(response);
	});
}

function makeRetrySchedule(delayMs: number) {
	return Schedule.recurs(MAX_OLLAMA_ATTEMPTS - 1).pipe(
		Schedule.addDelay(() =>
			Effect.logWarning({
				event: "generate_pr_content",
				status: "ollama_retry",
				message: "Title invalid or Ollama failed, retrying in 3s...",
			}).pipe(Effect.as(Duration.millis(delayMs))),
		),
	);
}

function getFallbackTitleAndDescription(filtered: readonly CommitInfo[]): {
	title: string;
	description: string;
} {
	const firstSubject = filtered[0]?.subject?.trim() ?? "";
	const title = isValidConventionalTitle(firstSubject) ? firstSubject : "chore: update";
	const description = getDescriptionFromCommits(filtered);
	return { title, description };
}

function generateTitleAndDescription(
	ollamaUrl: string,
	model: string,
	prompt: string,
	filtered: readonly CommitInfo[],
	retryDelayMs: number = RETRY_DELAY_MS,
): Effect.Effect<{ title: string; description: string }, Error, Http.HttpClient.HttpClient> {
	const attempt = callOllama(ollamaUrl, model, prompt).pipe(
		Effect.flatMap((raw) => Effect.fromResult(parseTitleDescriptionResponse(raw))),
		Effect.flatMap(({ title, description }) =>
			isValidConventionalTitle(title)
				? Effect.succeed({ title, description })
				: Effect.fail(new Error(`Title not in conventional format: "${title}"`)),
		),
	);
	return attempt.pipe(
		Effect.retry(makeRetrySchedule(retryDelayMs)),
		Effect.catch(() =>
			Effect.succeed(getFallbackTitleAndDescription(filtered)).pipe(
				Effect.tap(() =>
					Effect.logWarning({
						event: "generate_pr_content",
						status: "fallback",
						message: "Using fallback title after 5 invalid attempts",
					}),
				),
			),
		),
	);
}

// ─── Value-based API (no file I/O) ────────────────────────────────────────

/** Parameters for generatePrContentFromValues. All content as strings. */
export type GeneratePrContentFromValuesParams = {
	commitsContent: string;
	filesContent: string;
	templateContent: string;
	descriptionPromptText: string;
	howToTestDefault: string;
	model: string;
	ollamaUrl: string;
	/** Retry delay in ms. Use 0 for tests. Default 3000. */
	retryDelayMs?: number;
};

/**
 * Generate PR title and body from content. No file I/O.
 * Use for tests or when content is already in memory.
 */
export function generatePrContentFromValues(
	params: GeneratePrContentFromValuesParams,
): Effect.Effect<
	{ title: string; body: string; count: number },
	Error | NoSemanticCommitsError,
	Http.HttpClient.HttpClient
> {
	return Effect.gen(function* () {
		const {
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			howToTestDefault,
			model,
			ollamaUrl,
			retryDelayMs,
		} = params;

		const parseResult = parseCommits(commitsContent);
		const rawCommits = yield* Effect.fromResult(parseResult);
		const filtered = filterMergeCommits(rawCommits);
		const count = filtered.length;

		if (count === 0) {
			return yield* Effect.fail(
				new NoSemanticCommitsError({
					message:
						"No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing.",
				}),
			);
		}

		const files = parseFilesContent(filesContent);

		let title: string;
		let descriptionOverride: string | undefined;

		if (count >= 2) {
			const commitContent = getDescriptionPromptText(filtered);
			const prompt = buildDescriptionPrompt(descriptionPromptText, commitContent);
			const result = yield* generateTitleAndDescription(
				ollamaUrl,
				model,
				prompt,
				filtered,
				retryDelayMs ?? RETRY_DELAY_MS,
			);
			title = result.title;
			descriptionOverride = result.description;
		} else {
			title = getTitleFromCommits(filtered);
			descriptionOverride = undefined;
		}

		const bodyResult = renderBodyCore(
			filtered,
			files,
			templateContent,
			descriptionOverride,
			howToTestDefault,
		);
		const body = yield* Effect.fromResult(bodyResult);
		return { title, body, count };
	});
}

// ─── Main pipeline ───────────────────────────────────────────────────────

export function runGeneratePrContent(config: {
	commits: string;
	files: string;
	ghOutput: string;
	workspace: string;
	templatePath: string;
	model: string;
	ollamaUrl: string;
	howToTestDefault: string;
	/** Retry delay in ms. Use 0 for tests to avoid timeouts. Default 3000. */
	retryDelayMs?: number;
}): Effect.Effect<
	void,
	Error | NoSemanticCommitsError,
	FileSystem.FileSystem | Path.Path | Http.HttpClient.HttpClient
> {
	return Effect.gen(function* () {
		const {
			commits,
			files,
			ghOutput,
			workspace,
			templatePath,
			model,
			ollamaUrl,
			howToTestDefault,
			retryDelayMs,
		} = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const [commitsContent, filesContent, templateContent, descriptionPromptText] =
			yield* Effect.all([
				fs.readFileString(commits).pipe(Effect.mapError((e) => new Error(`commits: ${String(e)}`))),
				fs.readFileString(files).pipe(Effect.mapError((e) => new Error(`files: ${String(e)}`))),
				fs
					.readFileString(templatePath)
					.pipe(Effect.mapError((e) => new Error(`template: ${String(e)}`))),
				getPrDescriptionPromptPath().pipe(
					Effect.flatMap((p) =>
						fs
							.readFileString(p)
							.pipe(Effect.mapError((e) => new Error(`pr-description.txt: ${String(e)}`))),
					),
				),
			]);

		const { title, body, count } = yield* generatePrContentFromValues({
			commitsContent,
			filesContent,
			templateContent,
			descriptionPromptText,
			howToTestDefault,
			model,
			ollamaUrl,
			...(retryDelayMs !== undefined && { retryDelayMs }),
		});

		const bodyPath = pathApi.join(workspace, BODY_FILE_NAME);
		yield* fs
			.writeFileString(bodyPath, body)
			.pipe(Effect.mapError((e) => new Error(`write body: ${String(e)}`)));

		const entriesResult = buildGenerateContentGhEntries(title, bodyPath);
		const entries = yield* Effect.fromResult(entriesResult);
		yield* appendGhOutput(ghOutput, entries);
		yield* Effect.log({
			event: "generate_pr_content",
			status: "success",
			count,
			mode: count >= 2 ? "ollama" : "single_commit",
		});
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const GeneratePrContentLayer = Layer.mergeAll(AutoPrPlatformLayer, Http.FetchHttpClient.layer);

const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	const params = {
		commits: config.commits,
		files: config.files,
		ghOutput: config.ghOutput,
		workspace: config.workspace,
		templatePath: config.templatePath,
		model: config.model,
		ollamaUrl: config.ollamaUrl,
		howToTestDefault: config.howToTestDefault,
	};
	yield* runGeneratePrContent(params).pipe(Effect.provide(GeneratePrContentLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
