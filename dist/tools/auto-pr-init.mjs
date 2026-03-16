#!/usr/bin/env node

import { W as redactPath, o as runMain, r as PlatformLayer, t as AutoPrLoggerLayer } from "../auto-pr-gJsKsYcH.mjs";
import { Effect, FileSystem, Path } from "effect";
//#region src/lib/init-core.ts
/** File specs for init: dest (relative to cwd), optional from (package path), optional inline content. */
function getInitFileSpecs() {
	return [
		{
			dest: ".github/workflows/auto-pr.yml",
			from: ".github/workflows/auto-pr.yml"
		},
		{
			dest: ".github/PULL_REQUEST_TEMPLATE.md",
			from: ".github/PULL_REQUEST_TEMPLATE.md"
		},
		{
			dest: ".nvmrc",
			from: ".nvmrc"
		}
	];
}
//#endregion
//#region src/tools/init.ts
/**
* Initialize auto-pr in the current directory.
* Creates .github/workflows/auto-pr.yml, .github/PULL_REQUEST_TEMPLATE.md, .nvmrc.
*
* Run: npx auto-pr-init
*/
function copy(fs, pathApi, pkgRoot, from, to) {
	return Effect.gen(function* () {
		const srcPath = pathApi.join(pkgRoot, from);
		const content = yield* fs.readFileString(srcPath);
		const toDir = pathApi.dirname(to);
		yield* fs.makeDirectory(toDir, { recursive: true });
		yield* fs.writeFileString(to, content);
	});
}
function runInit(cwd) {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const pathApi = yield* Path.Path;
		const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
		const pkgRoot = pathApi.join(pathApi.dirname(scriptPath), "..", "..");
		for (const spec of getInitFileSpecs()) {
			const destPath = pathApi.join(cwd, spec.dest);
			if (yield* fs.exists(destPath)) yield* Effect.log({
				event: "init",
				status: "skipped",
				path: redactPath(destPath),
				reason: "already exists"
			});
			else if (spec.content !== void 0) {
				yield* fs.writeFileString(destPath, spec.content);
				yield* Effect.log({
					event: "init",
					status: "created",
					path: redactPath(destPath)
				});
			} else if (spec.from !== void 0) {
				yield* copy(fs, pathApi, pkgRoot, spec.from, destPath);
				yield* Effect.log({
					event: "init",
					status: "created",
					path: redactPath(destPath)
				});
			}
		}
		yield* Effect.log({
			event: "init",
			status: "next_steps",
			message: `Next steps (required for the workflow to create PRs):
1. Create a GitHub App: https://github.com/settings/apps/new
   - Permissions: Contents, Pull requests (Read and write)
   - Webhook: Uncheck Active
2. Generate a private key (app settings → Private keys)
3. Install the app on this repository
4. Add secrets to Settings → Secrets and variables → Actions:
   - APP_ID (from app settings → About)
   - APP_PRIVATE_KEY (full contents of the .pem file)

Then push to ai/* to test:
  git checkout -b ai/test && git commit --allow-empty -m "chore: test" && git push

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.`
		});
	});
}
if (import.meta.main) runMain(Effect.gen(function* () {
	yield* runInit(yield* Effect.sync(() => process.cwd()));
}).pipe(Effect.provide(PlatformLayer), Effect.provide(AutoPrLoggerLayer)), "init");
//#endregion
export { runInit };

//# sourceMappingURL=auto-pr-init.mjs.map