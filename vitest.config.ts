import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["./vitest.setup.ts"],
		reporters: ["default", "junit"],
		outputFile: { junit: "./test-report.junit.xml" },
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "lcov"],
			include: ["scripts/**/*.ts"],
			exclude: ["**/*.test.ts", "**/test/**"],
			thresholds: {
				lines: 70,
				functions: 65,
				statements: 70,
				branches: 55,
			},
		},
	},
});
