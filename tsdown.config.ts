import { defineConfig } from "tsdown";

export default defineConfig({
	banner: (chunk: { fileName?: string }) => {
		const f = String(chunk.fileName ?? "");
		return f.startsWith("workflow/") || f.startsWith("tools/") ? "#!/usr/bin/env node\n" : "";
	},
	entry: {
		"workflow/auto-pr-get-commits": "src/workflow/auto-pr-get-commits.ts",
		"workflow/auto-pr-generate-content": "src/workflow/generate-pr-content.ts",
		"workflow/auto-pr-create-or-update-pr": "src/workflow/create-or-update-pr.ts",
		"workflow/auto-pr-run": "src/workflow/run-auto-pr.ts",
		"tools/auto-pr-fill-pr-template": "src/tools/fill-pr-template.ts",
		"tools/auto-pr-init": "src/tools/init.ts",
	},
	format: "esm",
	target: "node24",
	sourcemap: true,
	clean: true,
	dts: false,
	copy: [{ from: "src/auto-pr/prompts/**", to: "dist/prompts", flatten: true }],
});
