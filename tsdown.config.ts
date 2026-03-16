import { defineConfig } from "tsdown";

export default defineConfig({
	banner: (chunk: { fileName?: string }) => {
		const f = String(chunk.fileName ?? "");
		return f.startsWith("workflow/") || f.startsWith("tools/") ? "#!/usr/bin/env node\n" : "";
	},
	entry: {
		"workflow/auto-pr-get-commits": "src/workflow/auto-pr-get-commits.ts",
		"workflow/generate-pr-content": "src/workflow/generate-pr-content.ts",
		"workflow/create-or-update-pr": "src/workflow/create-or-update-pr.ts",
		"workflow/run-auto-pr": "src/workflow/run-auto-pr.ts",
		"tools/fill-pr-template": "src/tools/fill-pr-template.ts",
		"tools/init": "src/tools/init.ts",
	},
	format: "esm",
	target: "node24",
	sourcemap: true,
	clean: true,
	dts: false,
	copy: [{ from: "src/auto-pr/prompts", to: "dist/workflow/prompts" }],
});
