#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "..", "scripts", "fill-pr-template.ts");
const r = spawnSync("npx", ["tsx", script, ...process.argv.slice(2)], {
	stdio: "inherit",
	shell: true,
});
process.exit(r.status ?? 1);
