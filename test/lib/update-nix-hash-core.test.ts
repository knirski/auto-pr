import { describe, expect, it, test } from "@effect/vitest";
import { Result } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { UpdateNixHashNotFoundError, UpdateNixHashUsageError } from "#auto-pr";
import {
	hasNpmDepsHash,
	isValidSha256Hash,
	parseCurrentNpmDepsHash,
	replaceNpmDepsHash,
} from "#lib/update-nix-hash-core.js";

const validHashArb = FastCheck.string({ minLength: 1, maxLength: 64 })
	.filter((s) => /^[A-Za-z0-9+/=_-]+$/.test(s))
	.map((s) => `sha256-${s}`);

describe("update-nix-hash-core", () => {
	describe("hasNpmDepsHash", () => {
		test("true when content has npmDepsHash", () => {
			expect(hasNpmDepsHash('npmDepsHash = "sha256-abc"')).toBe(true);
		});
		test("false when no hash", () => {
			expect(hasNpmDepsHash("let x = 1; in x")).toBe(false);
		});
	});

	describe("replaceNpmDepsHash", () => {
		test("replaces existing hash", () => {
			const content = 'npmDepsHash = "sha256-old"\n';
			expect(replaceNpmDepsHash(content, "sha256-new")).toBe('npmDepsHash = "sha256-new"\n');
		});
		test("returns unchanged content when no hash present", () => {
			const content = "let x = 1; in x\n";
			expect(replaceNpmDepsHash(content, "sha256-new")).toBe(content);
		});

		it.prop(
			"round-trip: replace then parse yields same hash for any valid hash",
			[validHashArb],
			([hash]) => {
				const content = 'npmDepsHash = "sha256-old"\n';
				const replaced = replaceNpmDepsHash(content, hash);
				const parsed = parseCurrentNpmDepsHash(replaced, "/path/default.nix");
				Result.match(parsed, {
					onSuccess: (v) => expect(v).toBe(hash),
					onFailure: () => expect.fail("parse should succeed after replace"),
				});
			},
		);
	});

	describe("isValidSha256Hash", () => {
		test("accepts valid hash", () => {
			expect(isValidSha256Hash("sha256-abc123")).toBe(true);
			expect(isValidSha256Hash("sha256-AbCdEf+/=")).toBe(true);
		});
		test("rejects invalid", () => {
			expect(isValidSha256Hash("")).toBe(false);
			expect(isValidSha256Hash("sha256-")).toBe(false);
			expect(isValidSha256Hash("invalid")).toBe(false);
		});
	});

	describe("parseCurrentNpmDepsHash", () => {
		test("succeeds when hash present", () => {
			const r = parseCurrentNpmDepsHash('npmDepsHash = "sha256-abc123"\n', "/path/default.nix");
			Result.match(r, {
				onSuccess: (v) => expect(v).toBe("sha256-abc123"),
				onFailure: () => expect.fail("expected success"),
			});
		});
		test("fails with UpdateNixHashNotFoundError when no hash", () => {
			const r = parseCurrentNpmDepsHash("let x = 1; in x", "/path/default.nix");
			Result.match(r, {
				onSuccess: () => expect.fail("expected failure"),
				onFailure: (e) => expect(e).toBeInstanceOf(UpdateNixHashNotFoundError),
			});
		});
		test("fails with UpdateNixHashUsageError when hash malformed", () => {
			// Has sha256- prefix but empty/invalid (fails isValidSha256Hash)
			const r = parseCurrentNpmDepsHash('npmDepsHash = "sha256-"\n', "/path/default.nix");
			Result.match(r, {
				onSuccess: () => expect.fail("expected failure"),
				onFailure: (e) => expect(e).toBeInstanceOf(UpdateNixHashUsageError),
			});
		});
	});
});
