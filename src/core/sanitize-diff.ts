/**
 * Pure diff sanitization for AI consumption. No Effect, no I/O.
 * Guards against binary files, oversized per-file diffs, and oversized total diffs.
 */

export const MAX_PER_FILE_DIFF_CHARS = 10_000;
export const MAX_TOTAL_DIFF_CHARS = 50_000;
export const MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS = 8_000;
// Current known request-size ceiling for openai/gpt-4.1 on GitHub Models.
export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4;
export const GITHUB_MODELS_GPT41_MAX_REQUEST_TOKENS = 8_000;
// Reserve headroom for prompt, accumulated chat/tool envelopes, and final JSON output.
export const TOOL_ROUNDTRIP_RESERVED_TOKENS = 5_000;
// Conservative fanout assumption for one round when the model issues multiple tool calls.
export const TOOL_ROUNDTRIP_ASSUMED_MAX_PARALLEL_TOOL_CALLS = 4;
// Keep a useful minimum diff payload even under strict request-size budgets.
export const MIN_AI_TOOL_ROUNDTRIP_DIFF_CHARS = 1_500;

/**
 * Future hardening options (prefer these over static constants when available):
 * 1. Fetch `max_input_tokens` dynamically from the GitHub Models catalog per selected model.
 * 2. Expose reserve/fanout knobs via env (e.g. AUTO_PR_AI_TOOL_*) with safe defaults.
 * 3. Adapt fanout based on observed tool-call count from previous rounds/retries.
 * 4. Store model-specific overrides in config data instead of embedding them in code.
 */

const isGithubModelsGpt41Family = (model: string): boolean => {
	const normalized = model.trim().toLowerCase();
	return normalized.startsWith("openai/gpt-4.1");
};

function clampNumber(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function deriveToolRoundtripCharBudgetFromRequestTokens(input: {
	readonly requestTokenLimit: number;
	readonly reservedTokens: number;
	readonly assumedMaxParallelToolCalls: number;
}): number {
	const availableTokens = Math.max(0, input.requestTokenLimit - input.reservedTokens);
	const budgetPerToolTokens = Math.floor(availableTokens / input.assumedMaxParallelToolCalls);
	const estimatedChars = budgetPerToolTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN;
	return clampNumber(
		estimatedChars,
		MIN_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
		MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
	);
}

/**
 * Split a combined diff string into per-file diff blocks.
 * Each block starts with "diff --git".
 */
function splitIntoDiffBlocks(raw: string): string[] {
	const blocks: string[] = [];
	const lines = raw.split("\n");
	let current: string[] = [];

	for (const line of lines) {
		if (line.startsWith("diff --git ") && current.length > 0) {
			blocks.push(current.join("\n"));
			current = [line];
		} else {
			current.push(line);
		}
	}
	if (current.length > 0) {
		blocks.push(current.join("\n"));
	}
	return blocks.filter((b) => b.trim().length > 0);
}

/**
 * Extract file path from a diff block header line "diff --git a/path b/path".
 * Returns the path from the b/ side.
 */
function extractFilePath(block: string): string {
	const match = block.match(/^diff --git a\/.+ b\/(.+)$/m);
	return match?.[1] ?? "unknown";
}

/**
 * Check if a diff block is for a binary file.
 */
function isBinaryBlock(block: string): boolean {
	return /^Binary files .+ and .+ differ$/m.test(block);
}

/**
 * Sanitize a single diff block: replace binary with marker, truncate if oversized.
 */
function sanitizeBlock(block: string): string {
	const filePath = extractFilePath(block);

	if (isBinaryBlock(block)) {
		return `[binary file: ${filePath}]`;
	}

	if (block.length > MAX_PER_FILE_DIFF_CHARS) {
		const truncated = block.slice(0, MAX_PER_FILE_DIFF_CHARS);
		return `${truncated}\n[truncated: ${block.length} chars total, showing first ${MAX_PER_FILE_DIFF_CHARS}]`;
	}

	return block;
}

/**
 * Sanitize a raw git diff for AI consumption.
 * - Replaces binary file hunks with a `[binary file: path]` marker.
 * - Truncates any single file's diff exceeding {@link MAX_PER_FILE_DIFF_CHARS}.
 * - Truncates the total diff if it exceeds {@link MAX_TOTAL_DIFF_CHARS} after per-file processing.
 */
export function sanitizeDiffForAi(raw: string): string {
	if (raw.length === 0) return raw;

	const blocks = splitIntoDiffBlocks(raw);
	if (blocks.length === 0) return raw;

	const sanitized = blocks.map(sanitizeBlock);

	let result = sanitized.join("\n");

	if (result.length > MAX_TOTAL_DIFF_CHARS) {
		result = `${result.slice(0, MAX_TOTAL_DIFF_CHARS)}\n[diff truncated: total size exceeded ${MAX_TOTAL_DIFF_CHARS} chars]`;
	}

	return result;
}

/**
 * Cap diff text returned by AI tools so it can safely round-trip into the next
 * model request, especially for providers with small request-size limits.
 */
export function resolveAiToolRoundtripDiffCharBudget(
	provider: "local" | "github-models",
	model: string,
): number {
	if (provider === "github-models" && isGithubModelsGpt41Family(model)) {
		return deriveToolRoundtripCharBudgetFromRequestTokens({
			requestTokenLimit: GITHUB_MODELS_GPT41_MAX_REQUEST_TOKENS,
			reservedTokens: TOOL_ROUNDTRIP_RESERVED_TOKENS,
			assumedMaxParallelToolCalls: TOOL_ROUNDTRIP_ASSUMED_MAX_PARALLEL_TOOL_CALLS,
		});
	}
	return MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS;
}

export function capDiffForAiToolRoundtrip(
	diff: string,
	maxChars = MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
): string {
	if (diff.length <= maxChars) return diff;

	const suffix = `\n[tool output truncated: total size exceeded ${maxChars} chars; request a narrower diff via get_diff({"path":"..."}) or get_commit_diff({"hash":"..."})]`;
	const bodyBudget = Math.max(0, maxChars - suffix.length);
	const truncated = diff.slice(0, bodyBudget);
	return `${truncated}${suffix}`;
}
