import { describe, expect, test } from "bun:test";
import {
	DEFAULT_AI_FALLBACK_STRATEGY,
	DefaultAiFallbackPolicy,
} from "#core/ai-fallback-policy-core.js";

describe("ai-fallback-policy-core", () => {
	const baseInput = {
		selectedGithubModel: "openai/gpt-4.1",
		githubFallbackChain: ["openai/gpt-4.1", "microsoft/phi-4-mini-instruct"],
		strongestLocalModel: "qwen3-4b-q4_k_m",
	} as const;

	test("uses github-chain-then-local as default", () => {
		const plan = DefaultAiFallbackPolicy.resolvePlan(baseInput);
		expect(plan.strategy).toBe(DEFAULT_AI_FALLBACK_STRATEGY);
		expect(plan.steps).toEqual([
			{ _tag: "github-model", model: "microsoft/phi-4-mini-instruct" },
			{ _tag: "local-model", model: "qwen3-4b-q4_k_m" },
			{ _tag: "commit-fallback" },
		]);
	});

	test("builds github-chain-only plan", () => {
		const plan = DefaultAiFallbackPolicy.resolvePlan({
			...baseInput,
			strategy: "github-chain-only",
		});
		expect(plan.steps).toEqual([
			{ _tag: "github-model", model: "microsoft/phi-4-mini-instruct" },
			{ _tag: "commit-fallback" },
		]);
	});

	test("builds local-only plan", () => {
		const plan = DefaultAiFallbackPolicy.resolvePlan({
			...baseInput,
			strategy: "local-only",
		});
		expect(plan.steps).toEqual([
			{ _tag: "local-model", model: "qwen3-4b-q4_k_m" },
			{ _tag: "commit-fallback" },
		]);
	});

	test("builds commit-fallback plan", () => {
		const plan = DefaultAiFallbackPolicy.resolvePlan({
			...baseInput,
			strategy: "commit-fallback",
		});
		expect(plan.steps).toEqual([{ _tag: "commit-fallback" }]);
	});
});
