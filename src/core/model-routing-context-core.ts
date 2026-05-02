import { Match } from "effect";

export type FileKind = "source" | "docs" | "test" | "generated" | "lockfile" | "package" | "other";

type NameStatusKind = "A" | "M" | "D" | "R" | "other";

export type RoutingContextHotspot = {
	readonly path: string;
	readonly churn: number;
	readonly insertions: number;
	readonly deletions: number;
	readonly kind: FileKind;
};

export type RoutingContextCommitSummary = {
	readonly semanticCommitCount: number;
	readonly mergeCommitCount: number;
	readonly breakingCommitCount: number;
	readonly typeCounts: Readonly<Record<string, number>>;
};

export type RoutingContextFileSummary = {
	readonly changedFiles: readonly string[];
	readonly topLevelDirs: readonly string[];
	readonly topFiles: readonly RoutingContextHotspot[];
	readonly topDirs: readonly RoutingContextHotspot[];
	readonly sourceFileCount: number;
	readonly docsFileCount: number;
	readonly testFileCount: number;
	readonly generatedFileCount: number;
	readonly lockfileCount: number;
	readonly packageManifestCount: number;
	readonly rawChurn: number;
	readonly sourceChurn: number;
	readonly generatedChurn: number;
	readonly hasBinaryFiles: boolean;
	readonly addedFileCount: number;
	readonly modifiedFileCount: number;
	readonly deletedFileCount: number;
	readonly renamedFileCount: number;
};

export type BuildFileSummaryInput = {
	readonly files: readonly string[];
	readonly numstat: readonly string[];
	readonly nameStatus: readonly string[];
};

export type CommitSummaryInput = {
	readonly type: string | undefined;
	readonly breaking: boolean;
};

type MutableFileSummary = {
	sourceFileCount: number;
	docsFileCount: number;
	testFileCount: number;
	generatedFileCount: number;
	lockfileCount: number;
	packageManifestCount: number;
	rawChurn: number;
	sourceChurn: number;
	generatedChurn: number;
	hasBinaryFiles: boolean;
	addedFileCount: number;
	modifiedFileCount: number;
	deletedFileCount: number;
	renamedFileCount: number;
};

function makeEmptyMutableFileSummary(): MutableFileSummary {
	return {
		sourceFileCount: 0,
		docsFileCount: 0,
		testFileCount: 0,
		generatedFileCount: 0,
		lockfileCount: 0,
		packageManifestCount: 0,
		rawChurn: 0,
		sourceChurn: 0,
		generatedChurn: 0,
		hasBinaryFiles: false,
		addedFileCount: 0,
		modifiedFileCount: 0,
		deletedFileCount: 0,
		renamedFileCount: 0,
	};
}

export function classifyFile(path: string): FileKind {
	if (
		/^(package-lock\.json|bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|flake\.lock)$/.test(
			path,
		)
	) {
		return "lockfile";
	}
	if (/^(package\.json|bun\.config\.[^/]+|flake\.nix)$/.test(path)) return "package";
	if (
		/(^|\/)(dist|build|out|coverage|vendor|__snapshots__|\.terraform)(\/|$)/.test(path) ||
		/(^|\/)\.next(\/|$)/.test(path) ||
		/\.lock$/.test(path) ||
		/\.min\.js$/.test(path) ||
		/\.map$/.test(path)
	) {
		return "generated";
	}
	if (/^docs\/|\.md$/.test(path)) return "docs";
	if (/^src\//.test(path)) return "source";
	if (/(^|\/)(test|tests|spec|specs)(\/|$)/.test(path) || /\.(test|spec)\.[^/]+$/.test(path))
		return "test";
	return "other";
}

function classifyNameStatus(line: string): NameStatusKind {
	const [statusRaw] = line.split(/\s+/);
	return Match.value(statusRaw?.charAt(0) ?? "").pipe(
		Match.when("A", () => "A" as const),
		Match.when("M", () => "M" as const),
		Match.when("D", () => "D" as const),
		Match.when("R", () => "R" as const),
		Match.orElse(() => "other" as const),
	);
}

function sortHotspots(items: readonly RoutingContextHotspot[]): readonly RoutingContextHotspot[] {
	return [...items].sort((a, b) => {
		if (b.churn !== a.churn) return b.churn - a.churn;
		return a.path.localeCompare(b.path);
	});
}

function bumpFileKindCount(summary: MutableFileSummary, kind: FileKind): void {
	Match.value(kind).pipe(
		Match.when("source", () => {
			summary.sourceFileCount++;
		}),
		Match.when("docs", () => {
			summary.docsFileCount++;
		}),
		Match.when("test", () => {
			summary.testFileCount++;
		}),
		Match.when("generated", () => {
			summary.generatedFileCount++;
		}),
		Match.when("lockfile", () => {
			summary.lockfileCount++;
		}),
		Match.when("package", () => {
			summary.packageManifestCount++;
		}),
		Match.when("other", () => undefined),
		Match.exhaustive,
	);
}

function bumpNameStatusCount(summary: MutableFileSummary, kind: NameStatusKind): void {
	Match.value(kind).pipe(
		Match.when("A", () => {
			summary.addedFileCount++;
		}),
		Match.when("M", () => {
			summary.modifiedFileCount++;
		}),
		Match.when("D", () => {
			summary.deletedFileCount++;
		}),
		Match.when("R", () => {
			summary.renamedFileCount++;
		}),
		Match.when("other", () => undefined),
		Match.exhaustive,
	);
}

function bumpChurn(summary: MutableFileSummary, kind: FileKind, churn: number): void {
	summary.rawChurn += churn;
	Match.value(kind).pipe(
		Match.when("source", () => {
			summary.sourceChurn += churn;
		}),
		Match.when("generated", () => {
			summary.generatedChurn += churn;
		}),
		Match.when("docs", () => undefined),
		Match.when("test", () => undefined),
		Match.when("lockfile", () => undefined),
		Match.when("package", () => undefined),
		Match.when("other", () => undefined),
		Match.exhaustive,
	);
}

function parseNumstatLine(line: string):
	| {
			readonly insertions: number;
			readonly deletions: number;
			readonly path: string;
			readonly binary: boolean;
	  }
	| undefined {
	const [insRaw, delRaw, ...paths] = line.split("\t");
	const path = paths[paths.length - 1];
	if (insRaw === undefined || delRaw === undefined || path === undefined || path === "") {
		return undefined;
	}
	const binary = insRaw === "-" || delRaw === "-";
	return {
		insertions: binary ? 0 : Number(insRaw),
		deletions: binary ? 0 : Number(delRaw),
		path,
		binary,
	};
}

export function buildCommitSummary(
	commits: readonly CommitSummaryInput[],
	mergeCommitCount: number,
): RoutingContextCommitSummary {
	const typeCounts: Record<string, number> = Object.create(null);
	let breakingCommitCount = 0;
	for (const commit of commits) {
		if (commit.breaking) breakingCommitCount++;
		const type = commit.type?.trim().toLowerCase();
		if (type !== undefined && type !== "") {
			typeCounts[type] = (typeCounts[type] ?? 0) + 1;
		}
	}
	return {
		semanticCommitCount: commits.length,
		mergeCommitCount,
		breakingCommitCount,
		typeCounts,
	};
}

export function buildFileSummary(input: BuildFileSummaryInput): RoutingContextFileSummary {
	const summary = makeEmptyMutableFileSummary();
	const topLevelDirs = new Set<string>();
	const topDirChurn = new Map<string, RoutingContextHotspot>();
	const fileHotspots = new Map<string, RoutingContextHotspot>();

	for (const file of input.files) {
		topLevelDirs.add(file.split("/", 1)[0] ?? "");
		bumpFileKindCount(summary, classifyFile(file));
	}

	for (const line of input.nameStatus) {
		bumpNameStatusCount(summary, classifyNameStatus(line));
	}

	for (const line of input.numstat) {
		const parsed = parseNumstatLine(line);
		if (parsed === undefined) continue;
		const { insertions, deletions, path } = parsed;
		if (parsed.binary) {
			summary.hasBinaryFiles = true;
		}
		const churn = insertions + deletions;
		const kind = classifyFile(path);
		bumpChurn(summary, kind, churn);

		const fileEntry: RoutingContextHotspot = {
			path,
			churn,
			insertions,
			deletions,
			kind,
		};
		fileHotspots.set(path, fileEntry);

		const top = path.split("/", 1)[0] ?? path;
		const dirEntry = topDirChurn.get(top);
		if (dirEntry === undefined) {
			topDirChurn.set(top, { ...fileEntry, path: top });
		} else {
			topDirChurn.set(top, {
				...dirEntry,
				churn: dirEntry.churn + churn,
				insertions: dirEntry.insertions + insertions,
				deletions: dirEntry.deletions + deletions,
			});
		}
	}

	return {
		changedFiles: [...input.files],
		topLevelDirs: [...topLevelDirs].sort((a, b) => a.localeCompare(b)),
		topFiles: sortHotspots([...fileHotspots.values()]),
		topDirs: sortHotspots([...topDirChurn.values()]),
		sourceFileCount: summary.sourceFileCount,
		docsFileCount: summary.docsFileCount,
		testFileCount: summary.testFileCount,
		generatedFileCount: summary.generatedFileCount,
		lockfileCount: summary.lockfileCount,
		packageManifestCount: summary.packageManifestCount,
		rawChurn: summary.rawChurn,
		sourceChurn: summary.sourceChurn,
		generatedChurn: summary.generatedChurn,
		hasBinaryFiles: summary.hasBinaryFiles,
		addedFileCount: summary.addedFileCount,
		modifiedFileCount: summary.modifiedFileCount,
		deletedFileCount: summary.deletedFileCount,
		renamedFileCount: summary.renamedFileCount,
	};
}
