import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const scriptPath = join(
	repoRoot,
	".github/actions/auto-pr-select-model-band/auto-pr-select-model-band.sh",
);

function git(cwd: string, args: string[]): void {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	expect(r.status).toBe(0);
}

test("select-model-band emits a default model for single-commit PRs", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-pr-select-model-band-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);

	mkdirSync(join(dir, "docs"), { recursive: true });
	writeFileSync(join(dir, "docs", "base.md"), "base\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "docs: base"]);
	git(dir, ["branch", "origin/main"]);

	git(dir, ["checkout", "-b", "feature"]);
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "feat: add app"]);

	const githubOutput = join(dir, "github_output");
	const r = spawnSync("bash", [scriptPath], {
		cwd: dir,
		env: {
			...process.env,
			AI_PROVIDER: "local",
			COMMITS_COUNT: "1",
			DEFAULT_BRANCH: "main",
			GITHUB_OUTPUT: githubOutput,
			INPUT_MODEL: "",
			WORKSPACE: dir,
		},
		encoding: "utf8",
	});
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");

	const output = readFileSync(githubOutput, "utf8");
	expect(output).toContain("selected_model=gpt-oss");
	expect(output).toContain("band=A");
	expect(output).toContain("n_sem=1");
});

test("select-model-band respects an explicit model override", () => {
	const dir = mkdtempSync(join(tmpdir(), "auto-pr-select-model-band-override-"));
	git(dir, ["init", "-b", "main"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test User"]);

	writeFileSync(join(dir, "base.txt"), "base\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "docs: base"]);
	git(dir, ["branch", "origin/main"]);
	git(dir, ["checkout", "-b", "feature"]);
	writeFileSync(join(dir, "change.txt"), "change\n");
	git(dir, ["add", "."]);
	git(dir, ["commit", "-m", "feat: change"]);

	const githubOutput = join(dir, "github_output");
	const r = spawnSync("bash", [scriptPath], {
		cwd: dir,
		env: {
			...process.env,
			AI_PROVIDER: "github-models",
			COMMITS_COUNT: "1",
			DEFAULT_BRANCH: "main",
			GITHUB_OUTPUT: githubOutput,
			INPUT_MODEL: "openai/gpt-4.1",
			WORKSPACE: dir,
		},
		encoding: "utf8",
	});
	expect(r.status).toBe(0);
	const output = readFileSync(githubOutput, "utf8");
	expect(output).toContain("selected_model=openai/gpt-4.1");
});
