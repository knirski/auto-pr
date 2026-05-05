import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const scriptPath = join(repoRoot, ".github/actions/load-env-ci/load-env-ci.sh");

test("load-env-ci appends vars and derives AUTO_PR_AI_OPENAI_COMPAT_URL from INTEGRATION_LLAMA_PORT", () => {
  const dir = mkdtempSync(join(tmpdir(), "load-env-ci-"));
  const githubEnv = join(dir, "github_env");
  writeFileSync(
    join(dir, ".env.ci"),
    `
# comment
INTEGRATION_LLAMA_PORT=8080
INTEGRATION_GITHUB_MODEL=microsoft/phi-4-mini-instruct
`,
  );
  const r = spawnSync("bash", [scriptPath], {
    env: { ...process.env, GITHUB_ENV: githubEnv, GITHUB_WORKSPACE: dir },
    encoding: "utf-8",
  });
  expect(r.status).toBe(0);
  if (r.stderr) expect(r.stderr.length).toBe(0);
  const out = readFileSync(githubEnv, "utf-8");
  expect(out).toContain("INTEGRATION_LLAMA_PORT=8080");
  expect(out).toContain("INTEGRATION_GITHUB_MODEL=microsoft/phi-4-mini-instruct");
  expect(out).toContain("AUTO_PR_AI_OPENAI_COMPAT_URL=http://127.0.0.1:8080/v1");
});

test("load-env-ci omit mode skips INTEGRATION_LLAMA_* and AUTO_PR_AI_OPENAI_COMPAT_URL", () => {
  const dir = mkdtempSync(join(tmpdir(), "load-env-ci-omit-"));
  const githubEnv = join(dir, "github_env");
  writeFileSync(
    join(dir, ".env.ci"),
    `
INTEGRATION_LLAMA_PORT=9999
INTEGRATION_LLAMA_STUB_MODEL_URL=https://example/model.gguf
INTEGRATION_GITHUB_MODEL=microsoft/phi-4-mini-instruct
`,
  );
  const r = spawnSync("bash", [scriptPath], {
    env: {
      ...process.env,
      GITHUB_ENV: githubEnv,
      GITHUB_WORKSPACE: dir,
      LOAD_ENV_CI_OMIT_LLAMA_INTEGRATION: "true",
    },
    encoding: "utf-8",
  });
  expect(r.status).toBe(0);
  const out = readFileSync(githubEnv, "utf-8");
  expect(out).toContain("INTEGRATION_GITHUB_MODEL=microsoft/phi-4-mini-instruct");
  expect(out).not.toContain("INTEGRATION_LLAMA_PORT");
  expect(out).not.toContain("INTEGRATION_LLAMA_STUB_MODEL_URL");
  expect(out).not.toContain("AUTO_PR_AI_OPENAI_COMPAT_URL");
});
