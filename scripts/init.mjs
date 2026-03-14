#!/usr/bin/env node
/**
 * Initialize auto-pr in the current directory.
 * Creates .github/workflows/auto-pr.yml, .github/PULL_REQUEST_TEMPLATE.md, .nvmrc.
 *
 * Run: npx auto-pr-init
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");

function copy(from, to) {
	const content = readFileSync(join(PKG_ROOT, from), "utf-8");
	mkdirSync(dirname(to), { recursive: true });
	writeFileSync(to, content);
	console.log(`Created ${to}`);
}

function main() {
	const cwd = process.cwd();

	// Workflow (reusable — no package.json required)
	const workflowDest = join(cwd, ".github", "workflows", "auto-pr.yml");
	if (existsSync(workflowDest)) {
		console.log(`Skipped ${workflowDest} (already exists)`);
	} else {
		copy(".github/workflows/auto-pr-consumer-reusable.yml", workflowDest);
	}

	// PR template
	const templateDest = join(cwd, ".github", "PULL_REQUEST_TEMPLATE.md");
	if (existsSync(templateDest)) {
		console.log(`Skipped ${templateDest} (already exists)`);
	} else {
		copy(".github/PULL_REQUEST_TEMPLATE.md", templateDest);
	}

	// .nvmrc
	const nvmrcDest = join(cwd, ".nvmrc");
	if (existsSync(nvmrcDest)) {
		console.log(`Skipped ${nvmrcDest} (already exists)`);
	} else {
		writeFileSync(nvmrcDest, "24\n");
		console.log(`Created ${nvmrcDest}`);
	}

	console.log(`
Next steps (required for the workflow to create PRs):
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

See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md for full instructions.
`);
}

main();
