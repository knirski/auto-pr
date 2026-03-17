#!/usr/bin/env bun
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });

const pkg = JSON.parse(await Bun.file(join(root, "package.json")).text()) as {
	bin: Record<string, string>;
};
const entrypoints = Object.values(pkg.bin).map((p) =>
	join(root, "src", p.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts")),
);

const result = await Bun.build({
	entrypoints,
	outdir: dist,
	root: src,
	format: "esm",
	target: "node",
	minify: true,
	production: true,
	sourcemap: "linked",
	splitting: true,
	banner: "#!/usr/bin/env node\n",
	naming: { entry: "[dir]/[name].js", chunk: "[name]-[hash].js", asset: "[name]-[hash].[ext]" },
});

if (!result.success) {
	process.stderr.write(`Build failed:\n${result.logs.map(String).join("\n")}\n`);
	process.exit(1);
}

cpSync(join(src, "auto-pr/prompts"), join(dist, "prompts"), { recursive: true });
