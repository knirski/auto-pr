export type AiFallbackStrategy =
	| "github-chain-then-local"
	| "github-chain-only"
	| "local-only"
	| "commit-fallback";

export const DEFAULT_AI_FALLBACK_STRATEGY: AiFallbackStrategy = "github-chain-then-local";

export type AiFallbackPlanStep =
	| { readonly _tag: "github-model"; readonly model: string }
	| { readonly _tag: "local-model"; readonly model: string }
	| { readonly _tag: "commit-fallback" };

export type AiFallbackPlan = {
	readonly strategy: AiFallbackStrategy;
	readonly githubFallbackChain: readonly string[];
	readonly steps: readonly AiFallbackPlanStep[];
};

export type ResolveAiFallbackPlanInput = {
	readonly selectedGithubModel: string;
	readonly githubFallbackChain: readonly string[];
	readonly strongestLocalModel: string;
	readonly strategy?: AiFallbackStrategy;
};

export type AiFallbackPolicy = {
	resolvePlan(input: ResolveAiFallbackPlanInput): AiFallbackPlan;
};

function dropSelectedModelHead(
	chain: readonly string[],
	selectedGithubModel: string,
): readonly string[] {
	if (chain.length === 0) return [];
	return chain[0] === selectedGithubModel ? chain.slice(1) : chain;
}

function githubSteps(models: readonly string[]): readonly AiFallbackPlanStep[] {
	return models.map((model) => ({ _tag: "github-model" as const, model }));
}

export const DefaultAiFallbackPolicy: AiFallbackPolicy = {
	resolvePlan(input) {
		const strategy = input.strategy ?? DEFAULT_AI_FALLBACK_STRATEGY;
		const githubModels = dropSelectedModelHead(
			input.githubFallbackChain,
			input.selectedGithubModel,
		);
		if (strategy === "github-chain-then-local") {
			return {
				strategy,
				githubFallbackChain: input.githubFallbackChain,
				steps: [
					...githubSteps(githubModels),
					{ _tag: "local-model", model: input.strongestLocalModel },
					{ _tag: "commit-fallback" },
				],
			};
		}
		if (strategy === "github-chain-only") {
			return {
				strategy,
				githubFallbackChain: input.githubFallbackChain,
				steps: [...githubSteps(githubModels), { _tag: "commit-fallback" }],
			};
		}
		if (strategy === "local-only") {
			return {
				strategy,
				githubFallbackChain: input.githubFallbackChain,
				steps: [
					{ _tag: "local-model", model: input.strongestLocalModel },
					{ _tag: "commit-fallback" },
				],
			};
		}
		return {
			strategy,
			githubFallbackChain: input.githubFallbackChain,
			steps: [{ _tag: "commit-fallback" }],
		};
	},
};
