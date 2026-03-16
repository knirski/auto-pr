/**
 * Updates npmDepsHash in default.nix. For contributors without Nix.
 * Usage: tsx src/tools/update-nix-hash.ts <sha256-hash>
 * Or: npm run update-nix-hash -- sha256-...
 *
 * The hash can be obtained from the failed nix CI job: expand the
 * "Update npmDepsHash if mismatch" step and copy it from the "Without Nix: ..." line.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import {
	AutoPrLoggerLayer,
	AutoPrPlatformLayer,
	formatError,
	redactPath,
	UpdateNixHashNotFoundError,
	UpdateNixHashUsageError,
} from "#auto-pr";
import { hasNpmDepsHash, replaceNpmDepsHash } from "#lib/update-nix-hash-core.js";
import pkg from "../../package.json" with { type: "json" };

/** Branded schema for sha256- prefixed Nix hashes. Exported for tests. */
export const Sha256HashSchema = Schema.String.pipe(
	Schema.check(Schema.isPattern(/^sha256-[A-Za-z0-9+/=_-]+$/)),
	Schema.brand("Sha256Hash"),
);
type Sha256Hash = Schema.Schema.Type<typeof Sha256HashSchema>;

function runUpdateNixHash(
	hash: Sha256Hash,
): Effect.Effect<void, UpdateNixHashNotFoundError | Error, FileSystem.FileSystem | Path.Path> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;
		const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
		const defaultNixPath = pathApi.join(pathApi.dirname(scriptPath), "..", "..", "default.nix");

		const content = yield* fs.readFileString(defaultNixPath);

		if (!hasNpmDepsHash(content)) {
			yield* Effect.fail(new UpdateNixHashNotFoundError({ path: defaultNixPath }));
		}

		const updated = replaceNpmDepsHash(content, hash);

		if (content === updated) {
			yield* Effect.log({
				event: "update_nix_hash",
				status: "unchanged",
				path: redactPath(defaultNixPath),
			});
			return;
		}

		yield* fs.writeFileString(defaultNixPath, updated);
		yield* Effect.log({
			event: "update_nix_hash",
			status: "updated",
			path: redactPath(defaultNixPath),
			hashPreview: hash.slice(0, 12),
		});
	});
}

const hashArgument = Argument.string("hash").pipe(
	Argument.withDescription("sha256-... hash from nix CI (Without Nix: ... line)"),
);

const updateNixHashCommand = Command.make(
	"update-nix-hash",
	{ hash: hashArgument },
	Effect.fn("update-nix-hash.handler")(function* ({ hash }) {
		const trimmed = hash.trim();
		const decoded = yield* Schema.decodeUnknownEffect(Sha256HashSchema)(trimmed).pipe(
			Effect.mapError(
				() =>
					new UpdateNixHashUsageError({
						message: "Usage: tsx src/tools/update-nix-hash.ts <sha256-hash>",
					}),
			),
		);
		yield* runUpdateNixHash(decoded);
	}),
);

const cliProgram = Command.run(updateNixHashCommand, { version: pkg.version });

const CliLayer = Layer.mergeAll(
	NodeServices.layer,
	NodePath.layer,
	AutoPrPlatformLayer,
	AutoPrLoggerLayer,
);

if (import.meta.main) {
	NodeRuntime.runMain(
		cliProgram.pipe(
			Effect.provide(CliLayer),
			Effect.tapError((e: unknown) =>
				Effect.logError({
					event: "update_nix_hash_failed",
					path: "default.nix",
					error: formatError(e),
				}),
			),
		) as Effect.Effect<void, unknown, never>,
	);
}

export { runUpdateNixHash };
