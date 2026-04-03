/**
 * llama-server via Testcontainers, following the LibsqlContainer pattern in Effect
 * (ServiceMap.Service + Layer.effect + Effect.acquireRelease + Layer.unwrap for dependents).
 *
 * Requires Docker. Uses the vendored tiny GGUF in `fixtures/` (no download).
 *
 * Fixture: `tiny-llama.gguf` from [Mozilla/test-llama](https://huggingface.co/Mozilla/test-llama)
 * (Apache-2.0) — minimal valid model for CI/smoke tests (~27 KiB).
 *
 * Image pin: bump digest after `docker pull ghcr.io/ggml-org/llama.cpp:server` then
 * `docker inspect ghcr.io/ggml-org/llama.cpp:server --format '{{index .RepoDigests 0}}'`.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ServiceMap } from "effect";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { aiProviderLayerFromConfig } from "#auto-pr/live/ai-provider.js";

/**
 * Same max wait as explicit-URL integration tests: port may be open before `/v1/models` is ready.
 * Matches `test/integration/ai-providers.integration.test.ts`.
 */
export const OPENAI_MODELS_READY_MAX_MS = 600_000;

/** Pinned for reproducible smoke tests; update digest when bumping llama.cpp. */
const LLAMA_IMAGE =
	"ghcr.io/ggml-org/llama.cpp@sha256:b730227f92f5463a660f3d9231f509967d966a7e54a12734cb63ca2a7bd285a2";

/** Must match `test/integration/fixtures/tiny-llama.gguf` (vendored). */
const LLAMACPP_INTEGRATION_FIXTURE_GGUF = "tiny-llama.gguf";

const LLAMACPP_TESTCONTAINER_PORT = 8080;

function openAiBaseUrlFromLlamacppContainer(container: StartedTestContainer): string {
	const host = container.getHost();
	const port = container.getMappedPort(LLAMACPP_TESTCONTAINER_PORT);
	return `http://${host}:${port}/v1`;
}

/** Wait until GET …/v1/models succeeds. */
export async function waitForOpenAiModelsEndpoint(
	openAiBaseUrl: string,
	maxMs: number,
): Promise<void> {
	const base = openAiBaseUrl.replace(/\/$/, "");
	const modelsUrl = base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
	const start = Date.now();
	let lastError: unknown;
	while (Date.now() - start <= maxMs) {
		try {
			const r = await fetch(modelsUrl);
			if (r.ok) {
				return;
			}
			lastError = new Error(`HTTP ${r.status}`);
		} catch (e) {
			lastError = e;
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error(
		`Timed out after ${maxMs}ms waiting for OpenAI-compatible server at ${modelsUrl}: ${String(lastError)}`,
	);
}

export class LlamacppTestContainer extends ServiceMap.Service<
	LlamacppTestContainer,
	StartedTestContainer
>()("test/LlamacppTestContainer") {
	static readonly layer = Layer.effect(LlamacppTestContainer)(
		Effect.acquireRelease(
			Effect.promise(async () => {
				const integrationDir = import.meta.dirname;
				const fixturesDir = join(integrationDir, "fixtures");
				const fixturePath = join(fixturesDir, LLAMACPP_INTEGRATION_FIXTURE_GGUF);
				await access(fixturePath).catch(() => {
					throw new Error(
						`Missing integration fixture ${fixturePath}. Ensure test/integration/fixtures/${LLAMACPP_INTEGRATION_FIXTURE_GGUF} is present (tracked in git).`,
					);
				});
				const container = await new GenericContainer(LLAMA_IMAGE)
					.withBindMounts([{ source: fixturesDir, target: "/models", mode: "ro" }])
					.withCommand([
						"-m",
						`/models/${LLAMACPP_INTEGRATION_FIXTURE_GGUF}`,
						"--port",
						String(LLAMACPP_TESTCONTAINER_PORT),
						"--host",
						"0.0.0.0",
					])
					.withExposedPorts(LLAMACPP_TESTCONTAINER_PORT)
					.withWaitStrategy(Wait.forListeningPorts())
					.withStartupTimeout(120_000)
					.start();
				return container;
			}),
			(container) => Effect.promise(() => container.stop()),
		),
	);

	/**
	 * OpenAI-compat `LanguageModel` layer from the running container (same idea as
	 * LibsqlContainer.layerClient). Waits for `/v1/models` before returning the layer.
	 */
	static layerAiProvider(model: string) {
		return Layer.unwrap(
			Effect.gen(function* () {
				const container = yield* LlamacppTestContainer;
				const openAiBaseUrl = openAiBaseUrlFromLlamacppContainer(container);
				yield* Effect.promise(() =>
					waitForOpenAiModelsEndpoint(openAiBaseUrl, OPENAI_MODELS_READY_MAX_MS),
				);
				return aiProviderLayerFromConfig({
					provider: "local",
					model,
					openaiCompatUrl: openAiBaseUrl,
				});
			}),
		).pipe(Layer.provide(LlamacppTestContainer.layer));
	}
}
