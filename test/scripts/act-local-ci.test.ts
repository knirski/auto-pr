import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner, ExitCode } from "effect/unstable/process/ChildProcessSpawner";
import { AutoPrLoggerLayer, AutoPrPlatformLayer } from "#auto-pr";
import {
	ACT_GENERATED_EVENT_RELATIVE_PATH,
	CI_EVENT,
	CI_WORKFLOW,
	resolveActLocalCiRunnerFromProcessEnv,
} from "#core/act-local-ci.js";
import pkg from "../../package.json" with { type: "json" };
import { actLocalCiCommand, program } from "../../scripts/act-local-ci.js";

const repoRoot = join(import.meta.dir, "..", "..");

/** Bun platform + logger (Command needs Terminal/Stdio). */
const ActLocalCiCliTestLayer = BunServices.layer.pipe(Layer.provideMerge(AutoPrLoggerLayer));

function runCli(args: string[]): Effect.Effect<void, unknown, never> {
	return Command.runWith(actLocalCiCommand, { version: pkg.version })(args).pipe(
		Effect.provide(ActLocalCiCliTestLayer),
	) as Effect.Effect<void, unknown, never>;
}

function childProcessSpawnerCaptureExit0(
	invocations: Array<{ command: string; args: readonly string[] }>,
): Layer.Layer<ChildProcessSpawner> {
	return Layer.mock(ChildProcessSpawner)({
		exitCode: (cmd) => {
			if (ChildProcess.isStandardCommand(cmd)) {
				invocations.push({ command: cmd.command, args: cmd.args });
			}
			return Effect.succeed(ExitCode(0));
		},
	});
}

describe("act-local-ci", () => {
	describe("CLI", () => {
		test("invalid mode fails parse (failure exit)", async () => {
			const exit = await Effect.runPromise(runCli(["bogus"]).pipe(Effect.exit));
			expect(Exit.isFailure(exit)).toBe(true);
			const pretty = Exit.match(exit, {
				onSuccess: () => "",
				onFailure: (cause) => Cause.pretty(cause),
			});
			expect(pretty.length).toBeGreaterThan(0);
		});
	});

	describe("program", () => {
		test("check + dryRun invokes direct backend with act argv (platform, -e, --dryrun, job)", async () => {
			const invocations: Array<{ command: string; args: readonly string[] }> = [];
			const layer = Layer.mergeAll(
				childProcessSpawnerCaptureExit0(invocations),
				AutoPrPlatformLayer,
			);
			await Effect.runPromise(
				program({ dryRun: true, mode: "check" }, repoRoot, {
					resolveActBackend: () => Option.some("direct"),
				}).pipe(Effect.provide(layer)),
			);
			expect(invocations.length).toBe(1);
			const first = invocations[0];
			expect(first).toBeDefined();
			if (first === undefined) return;
			const { command, args } = first;
			expect(command).toBe("bash");
			expect(args[0]).toContain("nix-run-if-missing.sh");
			expect(args[1]).toBe("act");
			const actArgv = args.slice(2);
			const expected = resolveActLocalCiRunnerFromProcessEnv(process.env, {
				mode: "check",
				dryRun: true,
			});
			expect(actArgv[0]).toBe(`-P${expected.runsOnLabel}=${expected.runnerImage}`);
			expect(actArgv).toContain("--dryrun");
			expect(actArgv).toContain("-W");
			expect(actArgv).toContain(CI_WORKFLOW);
			expect(actArgv).toContain(CI_EVENT);
			expect(actArgv).toContain("-j");
			expect(actArgv).toContain("check");
			const eIdx = actArgv.indexOf("-e");
			expect(eIdx).toBeGreaterThanOrEqual(0);
			expect(actArgv[eIdx + 1]).toBe(join(repoRoot, ACT_GENERATED_EVENT_RELATIVE_PATH));
			expect(actArgv.some((a) => a.startsWith("--artifact-server-path="))).toBe(true);
		});

		test("check + dryRun invokes gh backend with gh act argv", async () => {
			const invocations: Array<{ command: string; args: readonly string[] }> = [];
			const layer = Layer.mergeAll(
				childProcessSpawnerCaptureExit0(invocations),
				AutoPrPlatformLayer,
			);
			await Effect.runPromise(
				program({ dryRun: true, mode: "check" }, repoRoot, {
					resolveActBackend: () => Option.some("gh"),
				}).pipe(Effect.provide(layer)),
			);
			expect(invocations.length).toBe(1);
			const first = invocations[0];
			expect(first).toBeDefined();
			if (first === undefined) return;
			const { command, args } = first;
			expect(command).toBe("gh");
			expect(args[0]).toBe("act");
			const actArgv = args.slice(1);
			const expected = resolveActLocalCiRunnerFromProcessEnv(process.env, {
				mode: "check",
				dryRun: true,
			});
			expect(actArgv[0]).toBe(`-P${expected.runsOnLabel}=${expected.runnerImage}`);
			expect(actArgv).toContain("--dryrun");
			expect(actArgv).toContain(CI_WORKFLOW);
		});
	});
});
