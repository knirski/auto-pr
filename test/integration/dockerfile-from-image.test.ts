/**
 * Canonical parser: test/integration/dockerfile-from-image.ts. CI: resolve-llama-server-tag.sh --dockerfile-image must match (parity tests).
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "effect";
import { parseFirstFromImageDockerfileContent } from "./dockerfile-from-image.js";

const repoRoot = join(fileURLToPath(new URL("../../", import.meta.url)));
const resolveLlamaServerTagSh = join(
	repoRoot,
	".github/actions/resolve-llama-server-tag/resolve-llama-server-tag.sh",
);

async function imageViaReadDockerfileImageScript(dockerfileContent: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dockerfile-pin-"));
	try {
		await mkdir(join(dir, ".github", "llama-server"), { recursive: true });
		await writeFile(join(dir, ".github", "llama-server", "Dockerfile"), dockerfileContent, "utf8");
		const r = spawnSync("bash", [resolveLlamaServerTagSh, "--dockerfile-image", dir], {
			encoding: "utf8",
			windowsHide: true,
		});
		expect(r.status).toBe(0);
		return r.stdout.trim();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("parseFirstFromImageDockerfileContent", () => {
	const cases: readonly { name: string; dockerfile: string; want: string }[] = [
		{
			name: "simple FROM with digest",
			dockerfile:
				"FROM ghcr.io/x/y@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n",
			want: "ghcr.io/x/y@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
		},
		{
			name: "tag only",
			dockerfile: "FROM ghcr.io/ggml-org/llama.cpp:server\n",
			want: "ghcr.io/ggml-org/llama.cpp:server",
		},
		{
			name: "skips comments then FROM",
			dockerfile: "# header\n# more\nFROM alpine:3\n",
			want: "alpine:3",
		},
		{
			name: "optional platform flag",
			dockerfile: "FROM --platform=linux/amd64 ghcr.io/x/y:z\n",
			want: "ghcr.io/x/y:z",
		},
	];

	for (const c of cases) {
		test(c.name, async () => {
			const got = Result.getOrThrow(parseFirstFromImageDockerfileContent(c.dockerfile));
			expect(got).toBe(c.want);
			await expect(imageViaReadDockerfileImageScript(c.dockerfile)).resolves.toBe(c.want);
		});
	}

	test("fails when no FROM", () => {
		const r = parseFirstFromImageDockerfileContent("# only\n");
		expect(Result.isFailure(r)).toBe(true);
	});
});
