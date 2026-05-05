import type { AiError } from "effect/unstable/ai";
import type { GithubModelCatalogEntry } from "./github-model-routing.js";
import { pickGithubModelCatalogEntry } from "./github-model-routing.js";

export type GithubModelAttemptPlan = {
	readonly model: string;
	readonly requiresToolCalls: boolean;
	readonly selectionMode: string;
};

export type GithubModelFailureKind =
	| { readonly _tag: "RateLimited" }
	| { readonly _tag: "CapabilityMismatch" }
	| { readonly _tag: "Transient" }
	| { readonly _tag: "AuthOrConfig" }
	| { readonly _tag: "Unknown" };

export type GithubModelFallbackDecision = "next_attempt" | "final_fallback";

export function buildGithubModelAttemptPlan(input: {
	readonly selectedModel: string;
	readonly requiresToolCalls: boolean;
	readonly entries: readonly GithubModelCatalogEntry[];
	readonly maxAttempts?: number;
}): readonly GithubModelAttemptPlan[] {
	const maxAttempts = Math.max(1, input.maxAttempts ?? 6);
	let remaining = [...input.entries];
	let selectedModel = input.selectedModel;
	let requiresToolCalls = input.requiresToolCalls;
	const attempts: GithubModelAttemptPlan[] = [];

	for (let index = 0; index < maxAttempts; index++) {
		const selected = pickGithubModelCatalogEntry({
			selectedModel,
			entries: remaining,
			requiresToolCalls,
		});
		const duplicate = attempts.some(
			(a) => a.model === selected.model && a.requiresToolCalls === selected.requiresToolCalls,
		);
		if (duplicate) break;
		attempts.push({
			model: selected.model,
			requiresToolCalls: selected.requiresToolCalls,
			selectionMode: selected.selectionMode,
		});
		remaining = remaining.filter((entry) => entry.id !== selected.model);
		selectedModel = selected.model;
		requiresToolCalls = selected.requiresToolCalls;
		if (remaining.length === 0) break;
	}

	return attempts;
}

function includesAny(haystack: string, needles: readonly string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

const REQUEST_SIZE_NEEDLES = [
	"request body too large",
	"max size",
	"context length",
	"input too large",
	"maximum context length",
];

export const CapabilityMismatchFailure: GithubModelFailureKind = { _tag: "CapabilityMismatch" };
export const TransientFailure: GithubModelFailureKind = { _tag: "Transient" };

export function classifyGithubModelFailure(error: unknown): GithubModelFailureKind {
	if (typeof error === "object" && error !== null && "reason" in error) {
		const aiError = error as AiError.AiError;
		const tag = aiError.reason?._tag;
		if (tag === "AuthenticationError") return { _tag: "AuthOrConfig" };
		if (tag === "RateLimitError") return { _tag: "RateLimited" };
		if (tag === "NetworkError" || tag === "InternalProviderError") return TransientFailure;
		if (tag === "InvalidRequestError") {
			const message = `${aiError.message}`.toLowerCase();
			if (includesAny(message, REQUEST_SIZE_NEEDLES)) {
				return CapabilityMismatchFailure;
			}
			if (includesAny(message, ["tool", "tools", "function call", "function_call"])) {
				return CapabilityMismatchFailure;
			}
			return TransientFailure;
		}
	}
	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		if (includesAny(message, REQUEST_SIZE_NEEDLES)) {
			return CapabilityMismatchFailure;
		}
		if (includesAny(message, ["401", "403", "unauthorized", "forbidden", "authentication"])) {
			return { _tag: "AuthOrConfig" };
		}
		if (includesAny(message, ["429", "rate limit", "too many requests"]))
			return { _tag: "RateLimited" };
		if (includesAny(message, ["tool", "tools", "function call", "function_call"])) {
			return CapabilityMismatchFailure;
		}
		if (includesAny(message, ["timeout", "timed out", "temporar", "unavailable", "5xx", "500"])) {
			return TransientFailure;
		}
	}
	return { _tag: "Unknown" };
}

export function decideGithubModelFallback(input: {
	readonly failure: GithubModelFailureKind;
	readonly hasRemainingAttempts: boolean;
}): GithubModelFallbackDecision {
	if (!input.hasRemainingAttempts) return "final_fallback";
	if (input.failure._tag === "AuthOrConfig") return "final_fallback";
	return "next_attempt";
}
