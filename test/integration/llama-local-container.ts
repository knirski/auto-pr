/**
 * Local llama-server via Testcontainers: image ref from the first `FROM` line in `.github/llama-server/Dockerfile`,
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
import { parseFirstFromImageDockerfileContent } from "./dockerfile-from-image.js";

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

export class LlamaIntegrationDockerfileError extends Schema.TaggedErrorClass<LlamaIntegrationDockerfileError>()(
	"LlamaIntegrationDockerfileError",
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
	| LlamaIntegrationDockerfileError
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

const STARTUP_TIMEOUT_MS = 300_000;

/** Host/container llama-server port from `INTEGRATION_LLAMA_PORT` (`.env.ci`); not hardcoded. */
function llamaPortFromEnv(): Effect.Effect<number, LlamaIntegrationContainerError, never> {
	return Effect.gen(function* () {
		const raw = process.env.INTEGRATION_LLAMA_PORT?.trim();
		if (raw === undefined || raw === "") {
			return yield* Effect.fail(
				new LlamaIntegrationContainerError({
					message:
						"INTEGRATION_LLAMA_PORT is not set. Ensure .env.ci is loaded (bun run test:integration), use .env.local overrides, or export it; CI loads .env.ci.",
					cause: undefined,
				}),
			);
		}
		const n = Number.parseInt(raw, 10);
		if (!Number.isFinite(n) || n < 1 || n > 65535) {
			return yield* Effect.fail(
				new LlamaIntegrationContainerError({
					message: `INTEGRATION_LLAMA_PORT must be a TCP port 1–65535, got: ${raw}`,
					cause: undefined,
				}),
			);
		}
		return n;
	});
}

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

const readPinnedImageFromDockerfile = Effect.fn("readPinnedImageFromDockerfile")(function* () {
	const integrationTestDir = yield* integrationTestDirectory();
	const p = yield* Path.Path;
	const fs = yield* FileSystem.FileSystem;
	const dockerfilePath = p.resolve(
		integrationTestDir,
		"..",
		"..",
		".github",
		"llama-server",
		"Dockerfile",
	);
	const content = yield* fs.readFileString(dockerfilePath).pipe(
		Effect.mapError(
			(cause) =>
				new LlamaIntegrationDockerfileError({
					message: "Failed to read .github/llama-server/Dockerfile",
					cause,
				}),
		),
	);
	return yield* Effect.fromResult(
		parseFirstFromImageDockerfileContent(content).pipe(
			Result.mapError(
				(message) =>
					new LlamaIntegrationDockerfileError({
						message: `Invalid .github/llama-server/Dockerfile: ${message}`,
						cause: undefined,
					}),
			),
		),
	);
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
	const response = yield* http
		.get(modelUrlParsed)
		.pipe(
			Effect.mapError(
				(cause) =>
					new LlamaIntegrationHttpError({ operation: "download GGUF model (HTTPS)", cause }),
			),
		);
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(
			new LlamaIntegrationHttpError({
				operation: `download GGUF model (HTTPS): unexpected HTTP status ${response.status} from ${modelUrlParsed.href}`,
				cause: response,
			}),
		);
	}
	const buf = yield* response.arrayBuffer.pipe(
		Effect.map((ab) => new Uint8Array(ab)),
		Effect.mapError(
			(cause) => new LlamaIntegrationHttpError({ operation: "read GGUF response bytes", cause }),
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
	const response = yield* http
		.get(modelsUrl)
		.pipe(
			Effect.mapError(
				(cause) => new LlamaIntegrationHttpError({ operation: "request GET /v1/models", cause }),
			),
		);
	if (response.status < 200 || response.status >= 300) {
		return yield* Effect.fail(
			new LlamaIntegrationHttpError({
				operation: `request GET /v1/models: unexpected HTTP status ${response.status} from ${modelsUrl.href}`,
				cause: response,
			}),
		);
	}
	const json: unknown = yield* response.json.pipe(
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
	const containerPort = yield* llamaPortFromEnv();
	const modelPath = yield* ensureGgufModelFile({
		modelUrl: options.modelUrl,
		modelCacheDir: options.modelCacheDir,
	});
	const imageRef = yield* readPinnedImageFromDockerfile();
	const extra = options.extraLlamaArgs ?? [];
	return yield* Effect.acquireRelease(
		Effect.gen(function* () {
			const started = yield* Effect.tryPromise({
				try: () =>
					new GenericContainer(imageRef)
						.withExposedPorts(containerPort)
						.withBindMounts([{ source: modelPath, target: "/models/model.gguf", mode: "ro" }])
						.withCommand([
							"-m",
							"/models/model.gguf",
							"--port",
							String(containerPort),
							"--host",
							"0.0.0.0",
							...extra,
						])
						.withWaitStrategy(Wait.forHttp("/v1/models", containerPort))
						.withStartupTimeout(STARTUP_TIMEOUT_MS)
						.start(),
				catch: (cause) =>
					new LlamaIntegrationContainerError({
						message: "Failed to start llama-server container",
						cause,
					}),
			});
			const host = started.getHost();
			const port = started.getMappedPort(containerPort);
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
 * Acquire a running llama-server container (Dockerfile FROM pin + bind-mounted GGUF), release on scope close.
 * Uses {@link Effect.acquireRelease} so teardown runs with `Effect.scoped`.
 * Provides Node-compatible platform layers (FileSystem, Path, Fetch HTTP client) at the boundary.
 */
export const acquireLlamaLocalContainer = (
	options: LlamaLocalContainerOptions,
): Effect.Effect<LlamaLocalContainerReady, LlamaIntegrationTestError, Scope.Scope> =>
	acquireLlamaLocalContainerCore(options).pipe(Effect.provide(integrationPlatformLayer));
