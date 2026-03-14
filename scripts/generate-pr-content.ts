/**
 * Generate PR title and filled template body. Heavy lifting for auto-PR workflow.
 *
 * Requires env: COMMITS (path), FILES (path), GITHUB_OUTPUT
 * Optional env: OLLAMA_MODEL, OLLAMA_URL (for 2+ commits), GITHUB_WORKSPACE
 *
 * Parses commits to count semantic commits. For 1: FillPrTemplate only.
 * For 2+: Ollama generates description, then FillPrTemplate with override.
 *
 * Outputs to GITHUB_OUTPUT: title, body_file (path to filled template)
 *
 * Run: npx tsx scripts/generate-pr-content.ts
 */

import { Duration, Effect, FileSystem, Layer, Path, Schedule, Schema } from "effect";
import * as Http from "effect/unstable/http";
import {
	AutoPrPlatformLayer,
	appendGhOutput,
	buildDescriptionPrompt,
	FillPrTemplate,
	FillPrTemplateLiveLayer,
	GeneratePrContentConfig,
	GeneratePrContentConfigLayer,
	NoSemanticCommits,
	OllamaHttpError,
	PR_DESCRIPTION_PROMPT_PATH,
	runMain,
	sanitizeForGhOutput,
	trimOllamaResponse,
	validateDescriptionResponse,
} from "./auto-pr/index.js";
import {
	filterMergeCommits,
	getDescriptionPromptText,
	parseCommits,
} from "./fill-pr-template-core.js";

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
					r.status >= 400
						? Effect.fail(new OllamaHttpError({ status: r.status, cause: `HTTP ${r.status}` }))
						: Effect.succeed(r),
				),
			);
		const raw = yield* res.json;
		const decoded = yield* Schema.decodeUnknownEffect(OllamaResponseSchema)(raw).pipe(
			Effect.mapError((e) => new OllamaHttpError({ cause: `response: ${String(e)}` })),
		);
		const response = decoded.response ?? "";
		return trimOllamaResponse(response);
	});
}

const retrySchedule = Schedule.recurs(MAX_OLLAMA_ATTEMPTS - 1).pipe(
	Schedule.addDelay(() => Effect.succeed(Duration.millis(RETRY_DELAY_MS))),
);

function generateDescription(
	ollamaUrl: string,
	model: string,
	prompt: string,
): Effect.Effect<string, Error, Http.HttpClient.HttpClient> {
	return callOllama(ollamaUrl, model, prompt).pipe(
		Effect.flatMap((raw) => Effect.fromResult(validateDescriptionResponse(raw))),
		Effect.retry(retrySchedule),
		Effect.catch(() => Effect.succeed("")),
	);
}

// ─── Main pipeline ───────────────────────────────────────────────────────

export function runGeneratePrContent(config: {
	commits: string;
	files: string;
	ghOutput: string;
	workspace: string;
	model: string;
	ollamaUrl: string;
}) {
	return Effect.gen(function* () {
		const { commits, files, ghOutput, workspace, model, ollamaUrl } = config;
		const pathApi = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;

		const logContent = yield* fs
			.readFileString(commits)
			.pipe(Effect.mapError((e) => new Error(`commits: ${String(e)}`)));
		const parseResult = parseCommits(logContent);
		const rawCommits = yield* Effect.fromResult(parseResult);
		const filtered = filterMergeCommits(rawCommits);
		const count = filtered.length;

		if (count === 0) {
			return yield* Effect.fail(
				new NoSemanticCommits({
					message:
						"No semantic commits (all merge or non-semantic). Add at least one non-merge commit before pushing.",
				}),
			);
		}

		const fillPr = yield* FillPrTemplate;
		const howToTestDefault = process.env.AUTO_PR_HOW_TO_TEST ?? undefined;
		const fillParams = {
			logFilePath: commits,
			filesFilePath: files,
			...(howToTestDefault !== undefined && { howToTestDefault }),
		};

		let descriptionFilePath: string | undefined;
		if (count >= 2) {
			const descPrompt = yield* fs
				.readFileString(PR_DESCRIPTION_PROMPT_PATH)
				.pipe(Effect.mapError((e) => new Error(`pr-description.txt: ${String(e)}`)));
			const commitContent = getDescriptionPromptText(filtered);
			const prompt = buildDescriptionPrompt(descPrompt, commitContent);

			const desc = yield* generateDescription(ollamaUrl, model, prompt);
			if (desc && desc !== "null") {
				descriptionFilePath = pathApi.join(workspace, "description.txt");
				yield* fs
					.writeFileString(descriptionFilePath, desc)
					.pipe(Effect.mapError((e) => new Error(`write description: ${String(e)}`)));
			}
		}

		const title = yield* fillPr.getTitle(fillParams);
		const body = yield* fillPr.getBody({
			...fillParams,
			...(descriptionFilePath && { descriptionFilePath }),
		});

		const bodyPath = pathApi.join(workspace, BODY_FILE_NAME);
		yield* fs
			.writeFileString(bodyPath, body)
			.pipe(Effect.mapError((e) => new Error(`write body: ${String(e)}`)));

		const entries = [
			{ key: "title", value: sanitizeForGhOutput(title) },
			{ key: "body_file", value: bodyPath },
		];
		yield* appendGhOutput(ghOutput, entries);
	});
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const GeneratePrContentLayer = Layer.mergeAll(
	AutoPrPlatformLayer,
	FillPrTemplateLiveLayer,
	Http.FetchHttpClient.layer,
);

const program = Effect.gen(function* () {
	const config = yield* GeneratePrContentConfig;
	yield* runGeneratePrContent(config.config).pipe(Effect.provide(GeneratePrContentLayer));
}).pipe(Effect.provide(GeneratePrContentConfigLayer));

if (import.meta.main) {
	runMain(program, "generate_pr_content_failed");
}
