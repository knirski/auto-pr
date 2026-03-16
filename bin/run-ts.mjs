#!/usr/bin/env node
/**
 * Shared runner for TypeScript bin entry points.
 * Spawns tsx via npx (fetches when not installed). Use via: import { run } from "./run-ts.mjs"; run("script-name");
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function run(scriptName) {
	const script = join(__dirname, "..", "src", `${scriptName}.ts`);
	const r = spawnSync("npx", ["tsx", script, ...process.argv.slice(2)], {
		stdio: "inherit",
		shell: true,
	});
	process.exit(r.status ?? 1);
}
