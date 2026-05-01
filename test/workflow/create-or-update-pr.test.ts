import { describe, expect, test } from "bun:test";
import { Duration, Effect, Exit, type FileSystem, Layer, Option, type Path } from "effect";
import { PullRequestClient, PullRequestFailedError } from "#auto-pr";
import { PullRequestLookupError } from "#core/errors.js";
import { runEffect } from "#test/run-effect.js";
import { createTestTempDirEffect, SilentLoggerLayer, TestBaseLayer } from "#test/test-utils.js";
import { runCreateOrUpdatePr } from "#workflow/auto-pr-create-or-update-pr.js";

type Pull = { number: number; html_url: string; title?: string };

type FakeOctokit = {
	rest: {
		pulls: {
			list: (args: Record<string, unknown>) => Promise<{ data: Pull[] }>;
			update: (args: Record<string, unknown>) => Promise<{ data: Pull }>;
			create: (args: Record<string, unknown>) => Promise<{ data: Pull }>;
		};
	};
};

const TestLayer = Layer.mergeAll(TestBaseLayer, SilentLoggerLayer);
const runExit = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
	runEffect(TestLayer)(effect.pipe(Effect.exit));

function makeClient(params?: {
	readonly githubRepository?: string;
	readonly ghRepo?: string;
	readonly listImpl?: (args: Record<string, unknown>) => Promise<{ data: Pull[] }>;
	readonly updateImpl?: (args: Record<string, unknown>) => Promise<{ data: Pull }>;
	readonly createImpl?: (args: Record<string, unknown>) => Promise<{ data: Pull }>;
}) {
	const seen: {
		list: Array<Record<string, unknown>>;
		update: Array<Record<string, unknown>>;
		create: Array<Record<string, unknown>>;
	} = {
		list: [],
		update: [],
		create: [],
	};

	const listImpl =
		params?.listImpl ??
		(async (args) => {
			seen.list.push(args);
			return { data: [] };
		});
	const updateImpl =
		params?.updateImpl ??
		(async (args) => {
			seen.update.push(args);
			return { data: { number: 1, html_url: "https://github.com/owner/repo/pull/1" } };
		});
	const createImpl =
		params?.createImpl ??
		(async (args) => {
			seen.create.push(args);
			return { data: { number: 99, html_url: "https://github.com/owner/repo/pull/99" } };
		});

	const fakeOctokit: FakeOctokit = {
		rest: {
			pulls: {
				list: (args) => listImpl(args),
				update: (args) => updateImpl(args),
				create: (args) => createImpl(args),
			},
		},
	};

	const layer = PullRequestClient.Live("/tmp", {
		octokitFactory: () => fakeOctokit as never,
		...(params?.githubRepository !== undefined
			? { githubRepository: params.githubRepository }
			: {}),
		...(params?.ghRepo !== undefined ? { ghRepo: params.ghRepo } : {}),
		ghToken: "token",
	});

	return { layer, seen };
}

describe("PullRequestClient.findByBranch", () => {
	test("resolves repository from GITHUB_REPOSITORY", async () => {
		const { layer, seen } = makeClient({ githubRepository: "owner/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				yield* client.findByBranch("ai/foo");
				expect(seen.list[0]).toEqual({
					owner: "owner",
					repo: "repo",
					state: "open",
					head: "owner:ai/foo",
					per_page: 1,
				});
			}).pipe(Effect.provide(layer)),
		);
	});

	test("falls back to GH_REPO when GITHUB_REPOSITORY missing", async () => {
		const { layer, seen } = makeClient({ ghRepo: "fallback/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				yield* client.findByBranch("ai/fallback");
				expect(seen.list[0]).toEqual({
					owner: "fallback",
					repo: "repo",
					state: "open",
					head: "fallback:ai/fallback",
					per_page: 1,
				});
			}).pipe(Effect.provide(layer)),
		);
	});

	test("fails for malformed repository config", async () => {
		const { layer } = makeClient({ githubRepository: "malformed" });
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(Effect.provide(layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestLookupError")).toBe(true);
		}
	});

	test("fails with PullRequestLookupError when repository has blank owner/repo segment", async () => {
		const { layer } = makeClient({ githubRepository: "owner/" });
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(Effect.provide(layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestLookupError")).toBe(true);
		}
	});

	test("fails with PullRequestLookupError when repository config is missing", async () => {
		const { layer } = makeClient({ githubRepository: "" });
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(Effect.provide(layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestLookupError")).toBe(true);
			expect(String(exit.cause).includes("Missing repository config")).toBe(true);
		}
	});

	test("returns Option.none when list is empty", async () => {
		const { layer } = makeClient({ githubRepository: "owner/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const result = yield* client.findByBranch("ai/foo");
				expect(Option.isNone(result)).toBe(true);
			}).pipe(Effect.provide(layer)),
		);
	});

	test("returns Option.some for matching PR", async () => {
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			listImpl: async () => ({
				data: [{ number: 42, html_url: "https://github.com/owner/repo/pull/42", title: "feat: x" }],
			}),
		});
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const result = yield* client.findByBranch("ai/foo");
				expect(Option.isSome(result)).toBe(true);
				if (Option.isSome(result)) {
					expect(result.value.number).toBe(42);
					expect(result.value.url).toBe("https://github.com/owner/repo/pull/42");
					expect(result.value.title).toBe("feat: x");
				}
			}).pipe(Effect.provide(layer)),
		);
	});
});

describe("PullRequestClient create/update", () => {
	test("create returns html_url", async () => {
		const { layer, seen } = makeClient({ githubRepository: "owner/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("create-pr-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nDescription");
				const url = yield* client.create("ai/feature", "main", "feat: add feature", bodyPath);
				expect(url).toBe("https://github.com/owner/repo/pull/99");
				expect(seen.create[0]).toEqual({
					owner: "owner",
					repo: "repo",
					head: "ai/feature",
					base: "main",
					title: "feat: add feature",
					body: "# PR body\n\nDescription",
				});
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});

	test("update sends title and markdown body", async () => {
		const { layer, seen } = makeClient({ githubRepository: "owner/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("update-pr-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# Updated body\n\nDetails");
				yield* client.update(7, "feat: updated", bodyPath);
				expect(seen.update[0]).toEqual({
					owner: "owner",
					repo: "repo",
					pull_number: 7,
					title: "feat: updated",
					body: "# Updated body\n\nDetails",
				});
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
	});

	test("maps lookup API failures to PullRequestLookupError", async () => {
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			listImpl: async () => {
				throw new Error("bad credentials");
			},
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				return yield* client.findByBranch("ai/foo");
			}).pipe(Effect.provide(layer)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestLookupError")).toBe(true);
		}
	});

	test("maps create API failures to PullRequestFailedError", async () => {
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			createImpl: async () => {
				throw new Error("api unavailable");
			},
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("create-pr-fail-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "body");
				return yield* client.create("ai/feature", "main", "feat: add", bodyPath);
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestFailedError")).toBe(true);
		}
	});

	test("maps missing token to PullRequestFailedError", async () => {
		const fakeOctokit: FakeOctokit = {
			rest: {
				pulls: {
					list: async () => ({ data: [] }),
					update: async () => ({
						data: { number: 1, html_url: "https://github.com/owner/repo/pull/1" },
					}),
					create: async () => ({
						data: { number: 2, html_url: "https://github.com/owner/repo/pull/2" },
					}),
				},
			},
		};
		const layer = PullRequestClient.Live("/tmp", {
			octokitFactory: () => fakeOctokit as never,
			githubRepository: "owner/repo",
			ghToken: "",
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("update-pr-missing-token-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "body");
				return yield* client.update(1, "feat: x", bodyPath);
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestFailedError")).toBe(true);
			expect(String(exit.cause).includes("Missing GH_TOKEN")).toBe(true);
		}
	});

	test("maps non-Error API failures using stringified cause", async () => {
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			createImpl: async () => {
				throw "api unavailable";
			},
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("create-pr-fail-string-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "body");
				return yield* client.create("ai/feature", "main", "feat: add", bodyPath);
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestFailedError")).toBe(true);
			expect(String(exit.cause).includes("api unavailable")).toBe(true);
		}
	});

	test("maps update timeout to PullRequestFailedError", async () => {
		const fakeOctokit: FakeOctokit = {
			rest: {
				pulls: {
					list: async () => ({ data: [] }),
					update: () => new Promise(() => {}),
					create: async () => ({
						data: { number: 2, html_url: "https://github.com/owner/repo/pull/2" },
					}),
				},
			},
		};
		const layer = PullRequestClient.Live("/tmp", {
			octokitFactory: () => fakeOctokit as never,
			githubRepository: "owner/repo",
			ghToken: "token",
			apiTimeout: Duration.millis(1),
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const client = yield* PullRequestClient;
				const tmp = yield* createTestTempDirEffect("update-pr-timeout-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "body");
				return yield* client.update(1, "feat: timeout", bodyPath);
			}).pipe(Effect.provide(layer), Effect.scoped),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit)) {
			expect(String(exit.cause).includes("PullRequestFailedError")).toBe(true);
			expect(String(exit.cause).includes("timed out after 30s")).toBe(true);
		}
	});
});

describe("runCreateOrUpdatePr", () => {
	test("fails when body file missing", async () => {
		const { layer } = makeClient({ githubRepository: "owner/repo" });
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-");
				const exit = yield* runCreateOrUpdatePr({
					branch: "ai/test",
					defaultBranch: "main",
					title: "feat: add x",
					bodyFile: tmp.join("nonexistent.md"),
					workspace: tmp.path,
				}).pipe(Effect.provide(layer), Effect.exit);
				expect(exit._tag).toBe("Failure");
			}).pipe(Effect.scoped),
		);
	});

	test("retries PR create after transient failure", async () => {
		let createCalls = 0;
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			createImpl: async () => {
				createCalls += 1;
				if (createCalls === 1) throw new PullRequestFailedError({ cause: "temporary API failure" });
				return { data: { number: 99, html_url: "https://github.com/owner/repo/pull/99" } };
			},
		});

		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-retry-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nNew feature description.");

				yield* runCreateOrUpdatePr({
					branch: "ai/retry",
					defaultBranch: "main",
					title: "feat: add retry",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(layer));

				expect(createCalls).toBe(2);
			}).pipe(Effect.scoped),
		);
	});

	test("retries PR lookup after transient failure", async () => {
		let viewCalls = 0;
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			listImpl: async () => {
				viewCalls += 1;
				if (viewCalls === 1)
					throw new PullRequestLookupError({
						branch: "ai/retry-lookup",
						cause: "temporary API failure",
					});
				return { data: [] };
			},
		});

		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("create-pr-lookup-retry-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# PR body\n\nNew feature description.");

				yield* runCreateOrUpdatePr({
					branch: "ai/retry-lookup",
					defaultBranch: "main",
					title: "feat: retry lookup",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(layer));

				expect(viewCalls).toBe(2);
			}).pipe(Effect.scoped),
		);
	});

	test("uses update path when PR already exists", async () => {
		let updateCalls = 0;
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			listImpl: async () => ({
				data: [{ number: 7, html_url: "https://github.com/owner/repo/pull/7", title: "existing" }],
			}),
			updateImpl: async () => {
				updateCalls += 1;
				return { data: { number: 7, html_url: "https://github.com/owner/repo/pull/7" } };
			},
		});
		await runEffect(TestLayer)(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("update-existing-pr-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# Updated body");
				yield* runCreateOrUpdatePr({
					branch: "ai/existing",
					defaultBranch: "main",
					title: "feat: update existing",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(layer));
				expect(updateCalls).toBe(1);
			}).pipe(Effect.scoped),
		);
	});

	test("logs and fails after non-transient update failure", async () => {
		const { layer } = makeClient({
			githubRepository: "owner/repo",
			listImpl: async () => ({
				data: [{ number: 7, html_url: "https://github.com/owner/repo/pull/7", title: "existing" }],
			}),
			updateImpl: async () => {
				throw new PullRequestFailedError({ cause: "authentication failed" });
			},
		});
		const exit = await runExit(
			Effect.gen(function* () {
				const tmp = yield* createTestTempDirEffect("update-fail-pr-");
				const bodyPath = tmp.join("pr-body.md");
				yield* tmp.writeFile(bodyPath, "# Updated body");
				return yield* runCreateOrUpdatePr({
					branch: "ai/existing",
					defaultBranch: "main",
					title: "feat: update existing",
					bodyFile: bodyPath,
					workspace: tmp.path,
					retryDelay: Duration.zero,
				}).pipe(Effect.provide(layer));
			}).pipe(Effect.scoped),
		);
		expect(Exit.isFailure(exit)).toBe(true);
	});
});
