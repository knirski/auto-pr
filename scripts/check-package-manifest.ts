#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";

type PackageJson = {
	bin?: Record<string, string>;
	files?: string[];
	scripts?: Record<string, string>;
};

const root = join(import.meta.dir, "..");
const pkg = (await Bun.file(join(root, "package.json")).json()) as PackageJson;
const errors: string[] = [];

for (const [name, distPath] of Object.entries(pkg.bin ?? {})) {
	const sourcePath = distPath.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
	if (!existsSync(join(root, sourcePath))) {
		errors.push(`bin '${name}' points to ${distPath}, but source ${sourcePath} does not exist`);
	}
}

for (const entry of pkg.files ?? []) {
	if (!existsSync(join(root, entry))) {
		errors.push(`package files entry '${entry}' does not exist`);
	}
}

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
	const matches = command.matchAll(/\bbun run ([^\s&|;]+\.ts)\b/g);
	for (const match of matches) {
		const target = match[1];
		if (target !== undefined && !existsSync(join(root, target))) {
			errors.push(`script '${name}' references missing target ${target}`);
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) {
		process.stderr.write(`manifest check: ${error}\n`);
	}
	process.exit(1);
}
