/**
 * Updates npmDepsHash in default.nix when package-lock.json has changed.
 * Used by CI and update-nix-hash workflow.
 *
 * When an update is made: prints "hash=sha256-xxx" to stdout (for GITHUB_OUTPUT).
 * When no update needed: exits 0 with no output.
 * On error: exits 1.
 *
 * Must run from repository root (parent of default.nix and package-lock.json).
 *
 * Run: npx tsx src/tools/update-npm-deps-hash.ts
 */

import { Console, Effect, FileSystem, Path } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import {
	AutoPrPlatformLayer,
	ChildProcessSpawnerLayer,
	runMain,
	UpdateNixHashUsageError,
} from "#auto-pr";
import {
	isValidSha256Hash,
	parseCurrentNpmDepsHash,
	replaceNpmDepsHash,
} from "#lib/update-nix-hash-core.js";

function resolvePathsAndValidate(): Effect.Effect<
	{ root: string; defaultNixPath: string },
	UpdateNixHashUsageError | Error,
	FileSystem.FileSystem | Path.Path
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;

		const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
		const root = pathApi.join(pathApi.dirname(scriptPath), "..", "..");
		const defaultNixPath = pathApi.join(root, "default.nix");
		const packageLockPath = pathApi.join(root, "package-lock.json");

		const [defaultNixExists, packageLockExists] = yield* Effect.all([
			fs.exists(defaultNixPath),
			fs.exists(packageLockPath),
		]);

		if (!defaultNixExists || !packageLockExists) {
			return yield* Effect.fail(
				new UpdateNixHashUsageError({
					message: "default.nix or package-lock.json not found (run from repo root)",
				}),
			);
		}

		return { root, defaultNixPath };
	});
}

function fetchExpectedHash(
	root: string,
): Effect.Effect<string, UpdateNixHashUsageError | Error, ChildProcessSpawner> {
	return Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner;
		const rawHash = yield* spawner
			.string(
				ChildProcess.make("nix", ["run", ".#prefetch-npm-deps", "--", "package-lock.json"], {
					cwd: root,
				}),
			)
			.pipe(Effect.map((s) => s.trim()));
		if (!rawHash || !isValidSha256Hash(rawHash)) {
			return yield* Effect.fail(
				new UpdateNixHashUsageError({
					message: "prefetch-npm-deps failed or returned invalid hash",
				}),
			);
		}
		return rawHash;
	});
}

function runUpdateNpmDepsHash(): Effect.Effect<
	void,
	UpdateNixHashUsageError | Error,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const { root, defaultNixPath } = yield* resolvePathsAndValidate();
		const expected = yield* fetchExpectedHash(root);

		const content = yield* fs.readFileString(defaultNixPath);
		const current = yield* Effect.fromResult(parseCurrentNpmDepsHash(content, defaultNixPath));

		if (expected === current) {
			return;
		}

		const updated = replaceNpmDepsHash(content, expected);
		yield* fs.writeFileString(defaultNixPath, updated);
		yield* Console.log(`hash=${expected}`);
	});
}

function main(): Effect.Effect<void, UpdateNixHashUsageError | Error, never> {
	return runUpdateNpmDepsHash().pipe(
		Effect.provide(AutoPrPlatformLayer),
		Effect.provide(ChildProcessSpawnerLayer),
	);
}

if (import.meta.main) {
	runMain(main(), "update_npm_deps_hash");
}
