/**
 * Pure diff sanitization for AI consumption. No Effect, no I/O.
 * Guards against binary files, oversized per-file diffs, and oversized total diffs.
 */

export const MAX_PER_FILE_DIFF_CHARS = 10_000;
export const MAX_TOTAL_DIFF_CHARS = 50_000;
export const MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS = 8_000;

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
export function capDiffForAiToolRoundtrip(diff: string): string {
	if (diff.length <= MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS) return diff;

	const truncated = diff.slice(0, MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS);
	return `${truncated}\n[tool output truncated: total size exceeded ${MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS} chars; request a narrower diff via get_diff({"path":"..."}) or get_commit_diff({"hash":"..."})]`;
}
