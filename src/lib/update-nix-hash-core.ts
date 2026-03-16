/**
 * Pure core for update-nix-hash and update-npm-deps-hash. No Effect, no I/O.
 */

import { Result } from "effect";
import { UpdateNixHashNotFoundError, UpdateNixHashUsageError } from "#auto-pr/errors.js";

const NPM_DEPS_HASH_REGEX = /npmDepsHash = "sha256-[^"]*"/;
const HASH_REGEX = /^sha256-[A-Za-z0-9+/=_-]+$/;

/** Check if content contains npmDepsHash assignment. */
export function hasNpmDepsHash(content: string): boolean {
	return content.includes('npmDepsHash = "sha256-');
}

/** Replace npmDepsHash value in content. */
export function replaceNpmDepsHash(content: string, newHash: string): string {
	return content.replace(NPM_DEPS_HASH_REGEX, `npmDepsHash = "${newHash}"`);
}

/** Validate sha256- prefixed Nix hash format. */
export function isValidSha256Hash(s: string): boolean {
	return HASH_REGEX.test(s.trim());
}

/** Parse current npmDepsHash from default.nix content. */
export function parseCurrentNpmDepsHash(
	content: string,
	path: string,
): Result.Result<string, UpdateNixHashNotFoundError | UpdateNixHashUsageError> {
	const match = content.match(NPM_DEPS_HASH_REGEX);
	if (!match) {
		return Result.fail(new UpdateNixHashNotFoundError({ path }));
	}
	const valueMatch = content.match(/npmDepsHash = "([^"]*)"/);
	const current = valueMatch?.[1] ?? "";
	if (!current || !isValidSha256Hash(current)) {
		return Result.fail(
			new UpdateNixHashUsageError({
				message:
					'Could not parse npmDepsHash from default.nix (expected format: npmDepsHash = "sha256-...")',
			}),
		);
	}
	return Result.succeed(current);
}
