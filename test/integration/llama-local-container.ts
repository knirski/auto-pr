/**
 * Local llama-server via Testcontainers: image ref from `.github/llama-ci/llama-ci.json`,
 * bind-mount a downloaded `.gguf`, OpenAI-compat `/v1` for integration tests.
 *
 * Uses Effect {@link FileSystem}, {@link Path}, and {@link HttpClient} via Node-compatible platform layers (runs on Bun or Node).
 */
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import type { Scope } from "effect";
import {
	Effect,
	Array as EffectArray,
	FileSystem,
	Layer,
	Option,
	Path,
	pipe,
	Result,
	Schema,
} from "effect";
import * as Brand from "effect/Brand";
import { HttpClient } from "effect/unstable/http";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { GenericContainer, Wait } from "testcontainers";

/** Non-empty model id from `/v1/models` (validated before branding). */
export type OpenAiModelId = Brand.Branded<string, "OpenAiModelId">;

const OpenAiModelId = Brand.nominal<OpenAiModelId>();

/**
 * Native filesystem path string (not {@link Path.Path}, which is the path *service*).
 * Use {@link FsPath} to mark values that are intended as OS paths.
 */
export type FsPath = Brand.Branded<string, "FsPath">;

export const FsPath = Brand.nominal<FsPath>();

// --- Error hierarchy (tagged union: LlamaIntegrationTestError)

export class LlamaIntegrationLlamaCiJsonError extends Schema.TaggedErrorClass<LlamaIntegrationLlamaCiJsonError>()(
	"LlamaIntegrationLlamaCiJsonError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class LlamaIntegrationModelUrlError extends Schema.TaggedErrorClass<LlamaIntegrationModelUrlError>()(
	"LlamaIntegrationModelUrlError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

export class LlamaIntegrationHttpError extends Schema.TaggedErrorClass<LlamaIntegrationHttpError>()(
	"LlamaIntegrationHttpError",
	{
		operation: Schema.String,
		cause: Schema.Unknown,
	},
) {}

export class LlamaIntegrationModelsSchemaError extends Schema.TaggedErrorClass<LlamaIntegrationModelsSchemaError>()(
	"LlamaIntegrationModelsSchemaError",
	{
		message: Schema.String,
		cause: Schema.Unknown,
	},
) {}

export class LlamaIntegrationModelsEmptyError extends Schema.TaggedErrorClass<LlamaIntegrationModelsEmptyError>()(
	"LlamaIntegrationModelsEmptyError",
	{
		message: Schema.String,
	},
) {}

export class LlamaIntegrationFsError extends Schema.TaggedErrorClass<LlamaIntegrationFsError>()(
	"LlamaIntegrationFsError",
	{
		operation: Schema.String,
		cause: Schema.Unknown,
	},
) {}

export class LlamaIntegrationContainerError extends Schema.TaggedErrorClass<LlamaIntegrationContainerError>()(
	"LlamaIntegrationContainerError",
	{
		message: Schema.String,
		cause: Schema.Unknown,
	},
) {}

/** Discriminated union of all integration harness failures. */
export type LlamaIntegrationTestError =
	| LlamaIntegrationLlamaCiJsonError
	| LlamaIntegrationModelUrlError
	| LlamaIntegrationHttpError
	| LlamaIntegrationModelsSchemaError
	| LlamaIntegrationModelsEmptyError
	| LlamaIntegrationFsError
	| LlamaIntegrationContainerError;

/** Platform layers for integration I/O (HTTP + FS + paths; not Bun-specific). */
const integrationPlatformLayer = Layer.mergeAll(
	NodeFileSystem.layer,
	NodePath.layer,
	FetchHttpClient.layer,
);

const CONTAINER_PORT = 8080;
const STARTUP_TIMEOUT_MS = 300_000;

/** `test/integration/` as a native path via {@link Path.Path.fromFileUrl} (no `node:url`). */
const integrationTestDirectory = Effect.fn("integrationTestDirectory")(function* () {
	const p = yield* Path.Path;
	return yield* p.fromFileUrl(new URL(".", import.meta.url)).pipe(
		Effect.mapError(
			(cause) =>
				new LlamaIntegrationFsError({
					operation: "Path.fromFileUrl(integration module directory)",
					cause,
				}),
		),
	);
});

/** SHA-256 hex digest via Web Crypto (`crypto.subtle`), wrapped in Effect (no `node:crypto`). */
const sha256Hex = (input: string): Effect.Effect<string, never> =>
	Effect.promise(async () => {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
		return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
	});

const LlamaCiConfig = Schema.Struct({
	image: Schema.String,
});

/** Pure: llama-ci.json text → pinned image reference or error. */
function parsePinnedImageFromLlamaCiJsonContent(
	content: string,
): Result.Result<string, LlamaIntegrationLlamaCiJsonError> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (e: unknown) {
		return Result.fail(
			new LlamaIntegrationLlamaCiJsonError({
				message: "Failed to parse .github/llama-ci/llama-ci.json as JSON",
				cause: e,
			}),
		);
	}
	return pipe(
		Schema.decodeUnknownResult(LlamaCiConfig)(parsed),
		Result.mapError(
			(cause) =>
				new LlamaIntegrationLlamaCiJsonError({
					message: ".github/llama-ci/llama-ci.json did not match { image: string }",
					cause,
				}),
		),
		Result.flatMap((cfg) =>
			cfg.image.trim().length > 0
				? Result.succeed(cfg.image.trim())
				: Result.fail(
						new LlamaIntegrationLlamaCiJsonError({
							message: ".image must be non-empty in .github/llama-ci/llama-ci.json",
							cause: undefined,
						}),
					),
		),
	);
}

const OpenAiModelsListResponse = Schema.Struct({
	data: Schema.Array(
		Schema.Struct({
			id: Schema.String,
		}),
	),
});

type OpenAiModelsList = Schema.Schema.Type<typeof OpenAiModelsListResponse>;

function decodeOpenAiModelsJson(
	json: unknown,
): Result.Result<OpenAiModelsList, LlamaIntegrationModelsSchemaError> {
	return pipe(
		Schema.decodeUnknownResult(OpenAiModelsListResponse)(json),
		Result.mapError(
			(parseError: unknown) =>
				new LlamaIntegrationModelsSchemaError({
					message: "Response from /v1/models did not match OpenAI models list shape",
					cause: parseError,
				}),
		),
	);
}

function firstModelIdFromList(
	decoded: OpenAiModelsList,
): Result.Result<string, LlamaIntegrationModelsEmptyError> {
	return pipe(
		EffectArray.head(decoded.data),
		Option.match({
			onNone: () =>
				Result.fail(
					new LlamaIntegrationModelsEmptyError({
						message: "Empty data array from /v1/models",
					}),
				),
			onSome: (entry) =>
				entry.id.length > 0
					? Result.succeed(entry.id)
					: Result.fail(
							new LlamaIntegrationModelsEmptyError({
								message: "Empty model id from /v1/models",
							}),
						),
		}),
	);
}

function ensureHttpsModelUrl(url: URL): Result.Result<URL, LlamaIntegrationModelUrlError> {
	if (url.protocol !== "https:") {
		return Result.fail(
			new LlamaIntegrationModelUrlError({
				message: "modelUrl must use https",
				cause: undefined,
			}),
		);
	}
	return Result.succeed(url);
}

/** Resolves `.../v1/models` relative to the OpenAI-compat base. */
function openAiModelsListUrl(openAiCompatBase: URL): URL {
	const base = openAiCompatBase.href.endsWith("/")
		? openAiCompatBase.href
		: `${openAiCompatBase.href}/`;
	return new URL("models", base);
}

const readPinnedImageFromLlamaCiJson = Effect.fn("readPinnedImageFromLlamaCiJson")(function* () {
	const integrationTestDir = yield* integrationTestDirectory();
	const p = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const jsonPath = p.resolve(
		integrationTestDir,
		"..",
		"..",
		".github",
		"llama-ci",
		"llama-ci.json",
	);
	const content = yield* fs.readFileString(jsonPath).pipe(
		Effect.mapError(
			(cause) =>
				new LlamaIntegrationLlamaCiJsonError({
					message: "Failed to read .github/llama-ci/llama-ci.json",
					cause,
				}),
		),
	);
	return yield* Effect.fromResult(parsePinnedImageFromLlamaCiJsonContent(content));
});

const ensureGgufModelFile = Effect.fn("ensureGgufModelFile")(function* (options: {
	readonly modelUrl: URL;
	readonly modelCacheDir?: FsPath | undefined;
}) {
	const { modelUrl, modelCacheDir } = options;
	const modelUrlParsed = yield* Effect.fromResult(ensureHttpsModelUrl(modelUrl));
	const hash = yield* sha256Hex(modelUrl.href);
	const integrationTestDir = yield* integrationTestDirectory();
	const p = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const repoRoot = p.resolve(integrationTestDir, "..", "..");
	const cacheFile =
		modelCacheDir !== undefined && modelCacheDir.length > 0
			? p.resolve(modelCacheDir, hash, "model.gguf")
			: undefined;
	if (cacheFile !== undefined) {
		const exists = yield* fs
			.exists(cacheFile)
			.pipe(
				Effect.mapError(
					(cause) => new LlamaIntegrationFsError({ operation: "check cached model path", cause }),
				),
			);
		if (exists) {
			const info = yield* fs
				.stat(cacheFile)
				.pipe(
					Effect.mapError(
						(cause) => new LlamaIntegrationFsError({ operation: "stat cached model file", cause }),
					),
				);
			if (info.type === "File" && info.size > FileSystem.Size(0)) {
				return cacheFile;
			}
		}
	}
	const dest =
		cacheFile ??
		p.resolve(repoRoot, "node_modules", ".cache", "auto-pr-integration", hash, "model.gguf");
	const destDir = p.dirname(dest);
	yield* fs
		.makeDirectory(destDir, { recursive: true })
		.pipe(
			Effect.mapError(
				(cause) =>
					new LlamaIntegrationFsError({ operation: "create model cache directory", cause }),
			),
		);
	const http = yield* HttpClient.HttpClient;
	const okClient = pipe(http, HttpClient.filterStatusOk);
	const buf = yield* okClient.get(modelUrlParsed).pipe(
		Effect.flatMap((response) => response.arrayBuffer),
		Effect.map((ab) => new Uint8Array(ab)),
		Effect.mapError(
			(cause) => new LlamaIntegrationHttpError({ operation: "download GGUF model (HTTPS)", cause }),
		),
	);
	yield* fs
		.writeFile(dest, buf)
		.pipe(
			Effect.mapError(
				(cause) => new LlamaIntegrationFsError({ operation: "write model file", cause }),
			),
		);
	return dest;
});

const fetchFirstModelId = Effect.fn("fetchFirstModelId")(function* (openAiCompatBaseUrl: URL) {
	const modelsUrl = openAiModelsListUrl(openAiCompatBaseUrl);
	const http = yield* HttpClient.HttpClient;
	const okClient = pipe(http, HttpClient.filterStatusOk);
	const json: unknown = yield* okClient.get(modelsUrl).pipe(
		Effect.flatMap((response) => response.json),
		Effect.mapError(
			(cause) =>
				new LlamaIntegrationHttpError({ operation: "read JSON from GET /v1/models", cause }),
		),
	);
	const decoded = yield* Effect.fromResult(decodeOpenAiModelsJson(json));
	const id = yield* Effect.fromResult(firstModelIdFromList(decoded));
	return OpenAiModelId(id);
});

/** Options for {@link acquireLlamaLocalContainer}. */
export type LlamaLocalContainerOptions = {
	/** HTTPS URL of the `.gguf` to download (e.g. Hugging Face resolve URL). */
	readonly modelUrl: URL;
	readonly extraLlamaArgs?: ReadonlyArray<string> | undefined;
	/** Optional directory root for caching downloaded models (non-empty when set). */
	readonly modelCacheDir?: FsPath | undefined;
};

/** Running container: OpenAI-compatible base URL and first model id from `/v1/models`. */
export type LlamaLocalContainerReady = {
	readonly openAiCompatBaseUrl: URL;
	readonly modelId: OpenAiModelId;
};

const acquireLlamaLocalContainerCore = Effect.fn("acquireLlamaLocalContainer")(function* (
	options: LlamaLocalContainerOptions,
) {
	const modelPath = yield* ensureGgufModelFile({
		modelUrl: options.modelUrl,
		modelCacheDir: options.modelCacheDir,
	});
	const imageRef = yield* readPinnedImageFromLlamaCiJson();
	const extra = options.extraLlamaArgs ?? [];
	return yield* Effect.acquireRelease(
		Effect.gen(function* () {
			const started = yield* Effect.tryPromise({
				try: () =>
					new GenericContainer(imageRef)
						.withExposedPorts(CONTAINER_PORT)
						.withBindMounts([{ source: modelPath, target: "/models/model.gguf", mode: "ro" }])
						.withCommand([
							"-m",
							"/models/model.gguf",
							"--port",
							String(CONTAINER_PORT),
							"--host",
							"0.0.0.0",
							...extra,
						])
						.withWaitStrategy(Wait.forHttp("/v1/models", CONTAINER_PORT))
						.withStartupTimeout(STARTUP_TIMEOUT_MS)
						.start(),
				catch: (cause) =>
					new LlamaIntegrationContainerError({
						message: "Failed to start llama-server container",
						cause,
					}),
			});
			const host = started.getHost();
			const port = started.getMappedPort(CONTAINER_PORT);
			const openAiCompatBaseUrl = new URL(`http://${host}:${port}/v1`);
			const modelId = yield* fetchFirstModelId(openAiCompatBaseUrl);
			return { started, openAiCompatBaseUrl, modelId };
		}),
		(r) => Effect.promise(() => r.started.stop()),
	).pipe(
		Effect.map(
			(r): LlamaLocalContainerReady => ({
				openAiCompatBaseUrl: r.openAiCompatBaseUrl,
				modelId: r.modelId,
			}),
		),
	);
});

/**
 * Acquire a running llama-server container (llama-ci.json image pin + bind-mounted GGUF), release on scope close.
 * Uses {@link Effect.acquireRelease} so teardown runs with `Effect.scoped`.
 * Provides Node-compatible platform layers (FileSystem, Path, Fetch HTTP client) at the boundary.
 */
export const acquireLlamaLocalContainer = (
	options: LlamaLocalContainerOptions,
): Effect.Effect<LlamaLocalContainerReady, LlamaIntegrationTestError, Scope.Scope> =>
	acquireLlamaLocalContainerCore(options).pipe(Effect.provide(integrationPlatformLayer));
