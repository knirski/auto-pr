/**
 * Ensures {@link LlamaIntegrationTestError} stays aligned with exhaustive {@link Match.valueTags}.
 */
import { describe, expect, test } from "bun:test";
import { Match } from "effect";
import {
	LlamaIntegrationLlamaCiJsonError,
	type LlamaIntegrationTestError,
} from "./llama-local-container.js";

function formatIntegrationError(e: LlamaIntegrationTestError): string {
	return Match.valueTags(e, {
		LlamaIntegrationLlamaCiJsonError: (x) => x.message,
		LlamaIntegrationModelUrlError: (x) => x.message,
		LlamaIntegrationHttpError: (x) => `${x.operation}`,
		LlamaIntegrationModelsSchemaError: (x) => x.message,
		LlamaIntegrationModelsEmptyError: (x) => x.message,
		LlamaIntegrationFsError: (x) => `${x.operation}`,
		LlamaIntegrationContainerError: (x) => x.message,
	});
}

describe("LlamaIntegrationTestError", () => {
	test("Match.valueTags is exhaustive for llama-ci.json error", () => {
		const err: LlamaIntegrationTestError = new LlamaIntegrationLlamaCiJsonError({
			message: "missing image",
			cause: undefined,
		});
		expect(formatIntegrationError(err)).toBe("missing image");
	});
});
