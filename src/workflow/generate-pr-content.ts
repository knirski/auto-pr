/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: COMMITS (path), FILES (path), GITHUB_OUTPUT, GITHUB_WORKSPACE,
 * PR_TEMPLATE_PATH, OLLAMA_MODEL, OLLAMA_URL (for 2+ commits)
 * Requires env: AUTO_PR_HOW_TO_TEST
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only.
 * For 2+: Ollama generates description, then FillPrTemplate with override.
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
	FillPrTemplate,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	getPrDescriptionPromptPath,
	isHttpError,
	NoSemanticCommitsError,
	OllamaHttpError,
	runMain,
	trimOllamaResponse,
	validateDescriptionResponse,
} from "#auto-pr";
import type { CommitInfo } from "#lib/fill-pr-template-core.js";
import {
	filterMergeCommits,
	getDescriptionPromptText,
	parseCommits,
} from "#lib/fill-pr-template-core.js";

// ─── Constants ────────────────────────────────────────────────────────────

const BODY_FILE_NAME = "pr-body.md";
const MAX_OLLAMA_ATTEMPTS = 3;
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

const retrySchedule = Schedule.recurs(MAX_OLLAMA_ATTEMPTS - 1).pipe(
	Schedule.addDelay(() =>
		Effect.logWarning({
			event: "generate_pr_content",
			status: "ollama_retry",
			message: "Ollama failed, retrying in 3s...",
		}).pipe(Effect.as(Duration.millis(RETRY_DELAY_MS))),
	),
);

function generateDescription(
	ollamaUrl: string,
	model: string,
	prompt: string,
): Effect.Effect<string, Error, Http.HttpClient.HttpClient> {
	return callOllama(ollamaUrl, model, prompt).pipe(
		Effect.flatMap((raw) => Effect.fromResult(validateDescriptionResponse(raw))),
		Effect.retry(retrySchedule),
	);
}

// ─── Main pipeline ───────────────────────────────────────────────────────

function parseAndValidateCommits(
	commitsPath: string,
): Effect.Effect<
	{ filtered: readonly CommitInfo[]; count: number },
	Error | NoSemanticCommitsError,
	FileSystem.FileSystem
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const logContent = yield* fs
			.readFileString(commitsPath)
			.pipe(Effect.mapError((e) => new Error(`commits: ${String(e)}`)));
		const parseResult = parseCommits(logContent);
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
		return { filtered, count };
	});
}

function generateAndWriteDescription(
	workspace: string,
	ollamaUrl: string,
	model: string,
	filtered: readonly CommitInfo[],
): Effect.Effect<
	string | undefined,
	Error,
	FileSystem.FileSystem | Path.Path | Http.HttpClient.HttpClient
> {
	return Effect.gen(function* () {
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const promptPath = yield* getPrDescriptionPromptPath();
		const descPrompt = yield* fs
			.readFileString(promptPath)
			.pipe(Effect.mapError((e) => new Error(`pr-description.txt: ${String(e)}`)));
		const commitContent = getDescriptionPromptText(filtered);
		const prompt = buildDescriptionPrompt(descPrompt, commitContent);

		const desc = yield* generateDescription(ollamaUrl, model, prompt);
		if (desc === "null") return undefined;

		const descriptionFilePath = pathApi.join(workspace, "description.txt");
		yield* fs
			.writeFileString(descriptionFilePath, desc)
			.pipe(Effect.mapError((e) => new Error(`write description: ${String(e)}`)));
		return descriptionFilePath;
	});
}

export function runGeneratePrContent(config: {
	commits: string;
	files: string;
	ghOutput: string;
	workspace: string;
	templatePath: string;
	model: string;
	ollamaUrl: string;
	howToTestDefault: string;
}): Effect.Effect<
	void,
	Error | NoSemanticCommitsError,
	FileSystem.FileSystem | Path.Path | FillPrTemplate | Http.HttpClient.HttpClient
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
		} = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const { filtered, count } = yield* parseAndValidateCommits(commits);

		const fillPr = yield* FillPrTemplate;
		const fillParams = {
			logFilePath: commits,
			filesFilePath: files,
			templatePath,
			howToTestDefault,
		};

		const descriptionFilePath =
			count >= 2
				? yield* generateAndWriteDescription(workspace, ollamaUrl, model, filtered)
				: undefined;

		const title = yield* fillPr.getTitle(fillParams);
		const body = yield* fillPr.getBody({
			...fillParams,
			...(descriptionFilePath && { descriptionFilePath }),
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

const GeneratePrContentLayer = Layer.mergeAll(
	AutoPrPlatformLayer,
	FillPrTemplate.Live,
	Http.FetchHttpClient.layer,
);

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
