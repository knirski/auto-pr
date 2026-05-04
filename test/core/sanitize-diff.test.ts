import { describe, expect, test } from "bun:test";
import {
	capDiffForAiToolRoundtrip,
	GITHUB_MODELS_GPT41_MAX_REQUEST_TOKENS,
	MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
	MAX_PER_FILE_DIFF_CHARS,
	MAX_TOTAL_DIFF_CHARS,
	MIN_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
	resolveAiToolRoundtripDiffCharBudget,
	sanitizeDiffForAi,
	TOKEN_ESTIMATE_CHARS_PER_TOKEN,
	TOOL_ROUNDTRIP_ASSUMED_MAX_PARALLEL_TOOL_CALLS,
	TOOL_ROUNDTRIP_RESERVED_TOKENS,
} from "#core/sanitize-diff.js";

const makeBinaryFileDiff = (path: string) =>
	`diff --git a/${path} b/${path}\nindex abc..def 100644\nBinary files a/${path} and b/${path} differ\n`;

const makeFileDiff = (path: string, content: string) =>
	`diff --git a/${path} b/${path}\nindex 000..111 100644\n--- a/${path}\n+++ b/${path}\n${content}\n`;

describe("sanitizeDiffForAi", () => {
	test("returns diff unchanged when within limits", () => {
		const diff = makeFileDiff("src/foo.ts", "+const x = 1;\n-const y = 2;");
		const result = sanitizeDiffForAi(diff);
		expect(result).toContain("+const x = 1;");
		expect(result).not.toContain("[truncated");
		expect(result).not.toContain("[binary file");
	});

	test("replaces binary file hunks with [binary file: path] marker", () => {
		const diff = makeBinaryFileDiff("assets/image.png");
		const result = sanitizeDiffForAi(diff);
		expect(result).toContain("[binary file: assets/image.png]");
		expect(result).not.toContain("Binary files");
	});

	test("handles multiple files with one binary", () => {
		const diff =
			makeFileDiff("src/foo.ts", "+const x = 1;") +
			makeBinaryFileDiff("assets/logo.png") +
			makeFileDiff("src/bar.ts", "+const z = 3;");
		const result = sanitizeDiffForAi(diff);
		expect(result).toContain("[binary file: assets/logo.png]");
		expect(result).toContain("+const x = 1;");
		expect(result).toContain("+const z = 3;");
	});

	test("truncates per-file diff exceeding MAX_PER_FILE_DIFF_CHARS", () => {
		const bigContent = "+".repeat(MAX_PER_FILE_DIFF_CHARS + 5000);
		const diff = makeFileDiff("src/big.ts", bigContent);
		const result = sanitizeDiffForAi(diff);
		expect(result.length).toBeLessThan(diff.length);
		expect(result).toContain("[truncated:");
		expect(result).toContain("showing first");
	});

	test("truncates total diff exceeding MAX_TOTAL_DIFF_CHARS", () => {
		// Create enough files to exceed the total cap
		const filesNeeded = Math.ceil(MAX_TOTAL_DIFF_CHARS / (MAX_PER_FILE_DIFF_CHARS / 2)) + 1;
		const diffParts = Array.from({ length: filesNeeded }, (_, i) =>
			makeFileDiff(`src/file${i}.ts`, "+".repeat(MAX_PER_FILE_DIFF_CHARS / 2)),
		);
		const diff = diffParts.join("");
		const result = sanitizeDiffForAi(diff);
		expect(result.length).toBeLessThanOrEqual(MAX_TOTAL_DIFF_CHARS + 200); // allow for truncation marker
		expect(result).toContain("[diff truncated:");
	});

	test("passes through empty string unchanged", () => {
		expect(sanitizeDiffForAi("")).toBe("");
	});

	test("exports MAX_PER_FILE_DIFF_CHARS as 10000", () => {
		expect(MAX_PER_FILE_DIFF_CHARS).toBe(10_000);
	});

	test("exports MAX_TOTAL_DIFF_CHARS as 50000", () => {
		expect(MAX_TOTAL_DIFF_CHARS).toBe(50_000);
	});
});

describe("capDiffForAiToolRoundtrip", () => {
	test("passes through content under the tool round-trip cap", () => {
		const input = makeFileDiff("src/foo.ts", "+const x = 1;");
		expect(capDiffForAiToolRoundtrip(input)).toBe(input);
	});

	test("truncates content over the tool round-trip cap and adds guidance marker", () => {
		const input = "x".repeat(MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS + 1000);
		const result = capDiffForAiToolRoundtrip(input);
		expect(result.length).toBeLessThanOrEqual(MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS + 300);
		expect(result).toContain("[tool output truncated:");
		expect(result).toContain('get_diff({"path":"..."})');
		expect(result).toContain('get_commit_diff({"hash":"..."})');
	});

	test("exports MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS as 8000", () => {
		expect(MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS).toBe(8_000);
	});

	test("uses lower round-trip cap for github-models gpt-4.1", () => {
		const availableTokens = GITHUB_MODELS_GPT41_MAX_REQUEST_TOKENS - TOOL_ROUNDTRIP_RESERVED_TOKENS;
		const expected = Math.min(
			MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
			Math.max(
				MIN_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
				Math.floor(availableTokens / TOOL_ROUNDTRIP_ASSUMED_MAX_PARALLEL_TOOL_CALLS) *
					TOKEN_ESTIMATE_CHARS_PER_TOKEN,
			),
		);
		expect(resolveAiToolRoundtripDiffCharBudget("github-models", "openai/gpt-4.1")).toBe(expected);
	});

	test("uses default round-trip cap for other models/providers", () => {
		expect(resolveAiToolRoundtripDiffCharBudget("github-models", "openai/gpt-4.1-mini")).toBe(
			MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
		);
		expect(resolveAiToolRoundtripDiffCharBudget("local", "gpt-oss")).toBe(
			MAX_AI_TOOL_ROUNDTRIP_DIFF_CHARS,
		);
	});
});
