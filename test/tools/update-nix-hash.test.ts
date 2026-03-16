import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { UpdateNixHashNotFoundError } from "#auto-pr";
import { createTestTempDirEffect, TestBaseLayer } from "#test/test-utils.js";
import { runUpdateNixHash, Sha256HashSchema } from "#tools/update-nix-hash.js";

const toSha256Hash = (s: string) => Schema.decodeSync(Sha256HashSchema)(s);

layer(TestBaseLayer)("runUpdateNixHash", (it) => {
	it.effect("fails with UpdateNixHashNotFoundError when default.nix has no npmDepsHash", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("update-nix-hash-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			const defaultNixPath = pathApi.join(tmp.path, "default.nix");
			yield* fs.writeFileString(defaultNixPath, 'let x = "no hash here"; in x');

			const mockPath = {
				...pathApi,
				fromFileUrl: () =>
					Effect.succeed(pathApi.join(tmp.path, "src", "tools", "update-nix-hash.ts")),
			};

			const pathOverride = Layer.succeed(Path.Path, mockPath);
			const testLayer = Layer.merge(TestBaseLayer, pathOverride);

			const result = yield* runUpdateNixHash(toSha256Hash("sha256-abc123")).pipe(
				Effect.provide(testLayer),
				Effect.exit,
			);

			expect(Exit.isFailure(result)).toBe(true);
			const errOpt = Exit.match(result, {
				onSuccess: () => Option.none() as Option.Option<unknown>,
				onFailure: (cause) => Cause.findErrorOption(cause),
			});
			const found = Option.isSome(errOpt) && errOpt.value instanceof UpdateNixHashNotFoundError;
			expect(found).toBe(true);
		}).pipe(Effect.scoped),
	);

	it.effect("updates hash when default.nix has npmDepsHash", () =>
		Effect.gen(function* () {
			const tmp = yield* createTestTempDirEffect("update-nix-hash-");
			const fs = yield* FileSystem.FileSystem;
			const pathApi = yield* Path.Path;

			const defaultNixPath = pathApi.join(tmp.path, "default.nix");
			yield* fs.writeFileString(defaultNixPath, 'npmDepsHash = "sha256-oldhash"\n');

			const mockPath = {
				...pathApi,
				fromFileUrl: () =>
					Effect.succeed(pathApi.join(tmp.path, "src", "tools", "update-nix-hash.ts")),
			};

			const pathOverride = Layer.succeed(Path.Path, mockPath);
			const testLayer = Layer.merge(TestBaseLayer, pathOverride);

			yield* runUpdateNixHash(toSha256Hash("sha256-newhash")).pipe(Effect.provide(testLayer));

			const content = yield* fs.readFileString(defaultNixPath);
			expect(content).toContain('npmDepsHash = "sha256-newhash"');
		}).pipe(Effect.scoped),
	);
});
