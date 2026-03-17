import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import {
	errorToLogMessage,
	FileSystemError,
	formatFileSystemError,
	redactPath,
	unknownToMessage,
} from "#auto-pr/utils.js";

function redactedPath(label: string): Redacted.Redacted<string> {
	return Redacted.make(`/full/path/${label}`, { label });
}

describe("utils", () => {
	describe("redactPath", () => {
		test("returns basename for path with slashes", () => {
			expect(redactPath("/home/user/project/foo.ts")).toBe("foo.ts");
			expect(redactPath("src/bar.ts")).toBe("bar.ts");
		});

		test("returns full path when no slash", () => {
			expect(redactPath("single-file")).toBe("single-file");
		});

		test("returns last segment for trailing slash", () => {
			expect(redactPath("a/b/")).toBe("");
		});
	});

	describe("unknownToMessage", () => {
		test("returns message for Error", () => {
			expect(unknownToMessage(new Error("something failed"))).toBe("something failed");
		});

		test("returns String() for non-Error", () => {
			expect(unknownToMessage(42)).toBe("42");
			expect(unknownToMessage(null)).toBe("null");
			expect(unknownToMessage("plain string")).toBe("plain string");
		});
	});

	describe("errorToLogMessage", () => {
		test("uses formatFn for tagged errors", () => {
			const err = new FileSystemError({
				path: redactedPath("foo.ts"),
				operation: "read",
				message: "ENOENT",
			});
			const msg = errorToLogMessage(err, (e) => `Tagged: ${e._tag}`);
			expect(msg).toBe("Tagged: FileSystemError");
		});

		test("falls back to unknownToMessage when formatFn throws", () => {
			const err = new FileSystemError({
				path: redactedPath("foo.ts"),
				operation: "read",
				message: "ENOENT",
			});
			const msg = errorToLogMessage(err, () => {
				throw new Error("format failed");
			});
			// When formatFn throws, it falls back to unknownToMessage(e) which returns e.message
			expect(msg).toBe("ENOENT");
		});

		test("falls back to unknownToMessage for non-tagged errors", () => {
			const msg = errorToLogMessage(new Error("plain error"), () => "never called");
			expect(msg).toBe("plain error");
		});

		test("handles non-Error objects with _tag", () => {
			const msg = errorToLogMessage({ _tag: "CustomError" }, (e) => `Custom: ${e._tag}`);
			expect(msg).toBe("Custom: CustomError");
		});
	});

	describe("formatFileSystemError", () => {
		test("formats error with path and message", () => {
			const err = new FileSystemError({
				path: redactedPath("foo.ts"),
				operation: "read",
				message: "ENOENT",
			});
			const msg = formatFileSystemError(err);
			expect(msg).toContain("File system error");
			expect(msg).toContain("read");
			expect(msg).toContain("foo.ts");
			expect(msg).toContain("ENOENT");
		});

		test("includes fix when present", () => {
			const err = new FileSystemError({
				path: redactedPath("bar.ts"),
				operation: "write",
				message: "Permission denied",
				fix: "Check file permissions",
			});
			const msg = formatFileSystemError(err);
			expect(msg).toContain("Fix: Check file permissions");
		});
	});
});
