import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// vite-tsconfig-paths required: resolve.tsconfigPaths does not resolve #-prefixed paths from tsconfig.
export default defineConfig({
	plugins: [tsconfigPaths()],
	test: {
		setupFiles: ["./vitest.setup.ts"],
		reporters: ["default", "junit"],
		outputFile: { junit: "./test-report.junit.xml" },
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "lcov"],
			include: ["src/**/*.ts"],
			// run-auto-pr: full pipeline, needs real git; update-npm-deps-hash: thin wrapper, rarely changed
			exclude: ["**/run-auto-pr.ts", "**/update-npm-deps-hash.ts"],
			thresholds: {
				// ts-scripting skill goal: lines ≥90%, functions ≥85%.
				lines: 75,
				functions: 72,
				statements: 75,
				branches: 65,
			},
		},
	},
});
