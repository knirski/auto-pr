import { Config, Effect, FileSystem, Layer, Logger, Match, Option, Path, Redacted, Result, Schema, ServiceMap, pipe } from "effect";
import { CommitParser } from "conventional-commits-parser";
import * as Arr from "effect/Array";
import { render } from "micromustache";
import { remark } from "remark";
import { visit } from "unist-util-visit";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as NodePath from "@effect/platform-node-shared/NodePath";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
//#region src/auto-pr/utils.ts
/**
* Auto-PR utilities. Self-contained for standalone package.
*/
/** Redact path for logs: show basename only to avoid revealing home dir. */
function redactPath(path) {
	return path.split("/").pop() ?? path;
}
/** Convert unknown to a short message for display. */
function unknownToMessage(e) {
	return e instanceof Error ? e.message : String(e);
}
/** Wrap value for log-safe display. In formatters use r.label ?? "<redacted>". */
function redactedForLog(value, redact) {
	return Redacted.make(value, { label: redact(value) });
}
/** File system error for auto-PR. Compatible with Schema.TaggedErrorClass. */
var FileSystemError = class extends Schema.TaggedErrorClass()("FileSystemError", {
	path: Schema.Redacted(Schema.String),
	operation: Schema.String,
	message: Schema.String,
	fix: Schema.optional(Schema.String)
}) {};
/** Wrap raw FS errors as FileSystemError. Use with Effect.mapError. */
function wrapFs(path, op, fix) {
	return (e) => new FileSystemError({
		path: redactedForLog(path, redactPath),
		operation: op,
		message: unknownToMessage(e),
		fix
	});
}
/** Pipe helper: map Effect errors to FileSystemError. */
function mapFsError(path, op) {
	return (eff) => eff.pipe(Effect.mapError(wrapFs(path, op)));
}
/** Type guard for objects with _tag. */
function hasTag(obj) {
	return obj != null && typeof obj === "object" && "_tag" in obj;
}
/** Format unknown error for logs. For tagged errors, use formatFn; else unknownToMessage. */
function errorToLogMessage(e, formatFn) {
	if (hasTag(e)) try {
		return formatFn(e);
	} catch {
		return unknownToMessage(e);
	}
	return unknownToMessage(e);
}
function formatWithFix(base, fix) {
	return fix ? `${base}. Fix: ${fix}` : base;
}
/** Format FileSystemError for logs. */
function formatFileSystemError(err) {
	return formatWithFix(`File system error: ${err.operation} at ${err.path.label ?? "<redacted>"} (${err.message})`, err.fix);
}
//#endregion
//#region src/auto-pr/errors.ts
/**
* Tagged domain errors for auto-PR scripts.
* Self-contained for standalone package.
*/
/** gh CLI failed when creating or editing a PR (auth, network, rate limit, etc.). */
var PullRequestFailedError = class extends Schema.TaggedErrorClass()("PullRequestFailedError", { cause: Schema.String }) {};
/** Missing required env vars. Config validation failed. */
var AutoPrConfigError = class extends Schema.TaggedErrorClass()("AutoPrConfigError", { missing: Schema.Array(Schema.String) }) {};
/** Pull request title is empty. Add at least one non-merge commit with non-empty subject. */
var PullRequestTitleBlankError = class extends Schema.TaggedErrorClass()("PullRequestTitleBlankError", { message: Schema.String }) {};
/** Pull request body is empty. Add at least one non-merge commit with non-empty body. */
var PullRequestBodyBlankError = class extends Schema.TaggedErrorClass()("PullRequestBodyBlankError", { message: Schema.String }) {};
/** BODY_FILE path does not exist. Check generate-content step succeeded. */
var BodyFileNotFoundError = class extends Schema.TaggedErrorClass()("BodyFileNotFoundError", { path: Schema.String }) {};
/** Ollama HTTP request failed (timeout, 5xx, etc.). */
var OllamaHttpError = class extends Schema.TaggedErrorClass()("OllamaHttpError", {
	status: Schema.optional(Schema.Number),
	cause: Schema.String
}) {};
/** Ollama description response empty or invalid. */
var OllamaDescriptionInvalidError = class extends Schema.TaggedErrorClass()("OllamaDescriptionInvalidError", { cause: Schema.String }) {};
/** Parse error for commit message parsing failures. Used by fill-pr-template. */
var ParseError = class extends Schema.TaggedErrorClass()("ParseError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {};
/** No semantic commits (all merge or non-semantic). Add at least one non-merge commit. */
var NoSemanticCommitsError = class extends Schema.TaggedErrorClass()("NoSemanticCommitsError", { message: Schema.String }) {};
/** update-nix-hash: invalid hash or missing argument. */
var UpdateNixHashUsageError = class extends Schema.TaggedErrorClass()("UpdateNixHashUsageError", { message: Schema.String }) {};
/** update-nix-hash: no npmDepsHash found in default.nix. */
var UpdateNixHashNotFoundError = class extends Schema.TaggedErrorClass()("UpdateNixHashNotFoundError", { path: Schema.String }) {};
/** Template render failed (micromustache syntax error). */
var TemplateRenderError = class extends Schema.TaggedErrorClass()("TemplateRenderError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Unknown)
}) {};
/** FillPrTemplate params validation failed (e.g. templatePath required). */
var FillPrTemplateValidationError = class extends Schema.TaggedErrorClass()("FillPrTemplateValidationError", { message: Schema.String }) {};
/** Format script errors for logs. */
function formatError(e) {
	if (e instanceof PullRequestFailedError || e instanceof OllamaHttpError || e instanceof AutoPrConfigError || e instanceof PullRequestTitleBlankError || e instanceof PullRequestBodyBlankError || e instanceof BodyFileNotFoundError || e instanceof OllamaDescriptionInvalidError || e instanceof ParseError || e instanceof NoSemanticCommitsError || e instanceof UpdateNixHashUsageError || e instanceof UpdateNixHashNotFoundError || e instanceof TemplateRenderError || e instanceof FillPrTemplateValidationError) return Match.value(e).pipe(Match.tag("PullRequestFailedError", ({ cause }) => cause), Match.tag("OllamaHttpError", ({ status, cause }) => status == null ? cause : `Ollama HTTP ${status}: ${cause}`), Match.tag("AutoPrConfigError", ({ missing }) => `Missing required env: ${missing.join(", ")}. See https://github.com/knirski/auto-pr#environment-variables`), Match.tag("PullRequestTitleBlankError", ({ message }) => `${message} See https://www.conventionalcommits.org`), Match.tag("PullRequestBodyBlankError", ({ message }) => `${message} See https://www.conventionalcommits.org`), Match.tag("BodyFileNotFoundError", ({ path }) => `BODY_FILE does not exist: ${path}. Check generate-content step succeeded. See https://github.com/knirski/auto-pr/blob/main/docs/INTEGRATION.md#troubleshooting`), Match.tag("OllamaDescriptionInvalidError", ({ cause }) => cause), Match.tag("ParseError", ({ message, cause }) => cause == null ? message : `${message}: ${String(cause)}`), Match.tag("NoSemanticCommitsError", ({ message }) => `${message} See https://www.conventionalcommits.org`), Match.tag("UpdateNixHashUsageError", ({ message }) => message), Match.tag("UpdateNixHashNotFoundError", ({ path }) => `No npmDepsHash found in ${path}`), Match.tag("TemplateRenderError", ({ message, cause }) => cause == null ? message : `${message}: ${String(cause)}`), Match.tag("FillPrTemplateValidationError", ({ message }) => message), Match.exhaustive);
	return errorToLogMessage(e, (err) => {
		if (err instanceof FileSystemError) return formatFileSystemError(err);
		return unknownToMessage(e);
	});
}
//#endregion
//#region src/auto-pr/config.ts
/** Type guard for cause with message property. */
function hasMessage(obj) {
	return obj != null && typeof obj === "object" && "message" in obj;
}
/** Pure: extract missing env messages from ConfigError. */
function extractMissingFromConfigError(e) {
	return e.cause && hasMessage(e.cause) ? [String(e.cause.message ?? e.message)] : [e.message];
}
/** Fail when value is blank. Required vars must be non-empty. */
function requireNonEmpty(name, value) {
	return value.trim() === "" ? Effect.fail(new AutoPrConfigError({ missing: [`${name} must be non-empty`] })) : Effect.succeed(value);
}
function configErrorToAutoPrConfig(e) {
	return new AutoPrConfigError({ missing: extractMissingFromConfigError(e) });
}
function mapConfigError(effect) {
	return effect.pipe(Effect.mapError((e) => e instanceof AutoPrConfigError ? e : configErrorToAutoPrConfig(e)));
}
const GetCommitsConfig = ServiceMap.Service("GetCommitsConfig");
const GetCommitsConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghOutput: Config.string("GITHUB_OUTPUT")
});
const GetCommitsConfigLayer = Layer.effect(GetCommitsConfig, mapConfigError(Effect.gen(function* () {
	const base = yield* GetCommitsConfigDef;
	return {
		defaultBranch: yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch),
		workspace: yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace),
		ghOutput: yield* requireNonEmpty("GITHUB_OUTPUT", base.ghOutput)
	};
})));
const GeneratePrContentConfig = ServiceMap.Service("GeneratePrContentConfig");
const GeneratePrContentConfigDef = Config.all({
	commits: Config.string("COMMITS"),
	files: Config.string("FILES"),
	ghOutput: Config.string("GITHUB_OUTPUT"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	model: Config.string("OLLAMA_MODEL"),
	ollamaUrl: Config.string("OLLAMA_URL"),
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST")
});
const GeneratePrContentConfigLayer = Layer.effect(GeneratePrContentConfig, mapConfigError(Effect.gen(function* () {
	const base = yield* GeneratePrContentConfigDef;
	return {
		commits: yield* requireNonEmpty("COMMITS", base.commits),
		files: yield* requireNonEmpty("FILES", base.files),
		ghOutput: yield* requireNonEmpty("GITHUB_OUTPUT", base.ghOutput),
		workspace: yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace),
		templatePath: yield* requireNonEmpty("PR_TEMPLATE_PATH", base.templatePath),
		model: yield* requireNonEmpty("OLLAMA_MODEL", base.model),
		ollamaUrl: yield* requireNonEmpty("OLLAMA_URL", base.ollamaUrl),
		howToTestDefault: yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault)
	};
})));
const CreateOrUpdatePrConfig = ServiceMap.Service("CreateOrUpdatePrConfig");
const CreateOrUpdatePrConfigDef = Config.all({
	branch: Config.string("BRANCH"),
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	title: Config.string("TITLE"),
	bodyFile: Config.string("BODY_FILE"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	ghToken: Config.redacted("GH_TOKEN")
});
const CreateOrUpdatePrConfigLayer = Layer.effect(CreateOrUpdatePrConfig, mapConfigError(Effect.gen(function* () {
	const base = yield* CreateOrUpdatePrConfigDef;
	return {
		branch: yield* requireNonEmpty("BRANCH", base.branch),
		defaultBranch: yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch),
		title: yield* requireNonEmpty("TITLE", base.title),
		bodyFile: yield* requireNonEmpty("BODY_FILE", base.bodyFile),
		workspace: yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace),
		ghToken: base.ghToken
	};
})));
const RunAutoPrConfig = ServiceMap.Service("RunAutoPrConfig");
const RunAutoPrConfigDef = Config.all({
	defaultBranch: Config.string("DEFAULT_BRANCH"),
	workspace: Config.string("GITHUB_WORKSPACE"),
	templatePath: Config.string("PR_TEMPLATE_PATH"),
	ghToken: Config.redacted("GH_TOKEN"),
	model: Config.string("OLLAMA_MODEL"),
	ollamaUrl: Config.string("OLLAMA_URL"),
	branch: Config.option(Config.string("BRANCH")),
	howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST")
});
const RunAutoPrConfigLayer = Layer.effect(RunAutoPrConfig, mapConfigError(Effect.gen(function* () {
	const base = yield* RunAutoPrConfigDef;
	const defaultBranch = yield* requireNonEmpty("DEFAULT_BRANCH", base.defaultBranch);
	const workspace = yield* requireNonEmpty("GITHUB_WORKSPACE", base.workspace);
	const templatePath = yield* requireNonEmpty("PR_TEMPLATE_PATH", base.templatePath);
	const model = yield* requireNonEmpty("OLLAMA_MODEL", base.model);
	const ollamaUrl = yield* requireNonEmpty("OLLAMA_URL", base.ollamaUrl);
	const howToTestDefault = yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", base.howToTestDefault);
	return {
		defaultBranch,
		workspace,
		templatePath,
		ghToken: base.ghToken,
		model,
		ollamaUrl,
		branch: Option.getOrUndefined(base.branch),
		howToTestDefault
	};
})));
const FillPrTemplateConfig = ServiceMap.Service("FillPrTemplateConfig");
const FillPrTemplateConfigDef = Config.all({ howToTestDefault: Config.string("AUTO_PR_HOW_TO_TEST") });
const FillPrTemplateConfigLayer = Layer.effect(FillPrTemplateConfig, mapConfigError(Effect.gen(function* () {
	return { howToTestDefault: yield* requireNonEmpty("AUTO_PR_HOW_TO_TEST", (yield* FillPrTemplateConfigDef).howToTestDefault) };
})));
//#endregion
//#region src/auto-pr/core.ts
/**
* Pure core for auto-PR scripts. No Effect, no I/O.
*/
/** Branded type for sanitized GITHUB_OUTPUT values (max 72 chars, percent/CR/newline escaped). */
const GhOutputValueSchema = Schema.String.pipe(Schema.check(Schema.isMaxLength(72)), Schema.brand("GhOutputValue"));
/** Merge commits (e.g. "Merge branch 'x' into y") add no semantic value. */
function isMergeCommitSubject(subject) {
	return /^Merge /i.test(subject.trim());
}
/** Filter out merge commits and blank lines from subject list. */
function filterSemanticSubjects(subjects) {
	return subjects.map((s) => s.trim()).filter((line) => !isBlank(line) && !isMergeCommitSubject(line));
}
/** Format GITHUB_OUTPUT entries as key=value lines. */
function formatGhOutput(entries) {
	return `${entries.map((e) => `${e.key}=${e.value}`).join("\n")}\n`;
}
/**
* Escape value for GITHUB_OUTPUT format. Percent-encodes `%` → `%25`, `\n` → `%0A`, `\r` → `%0D`.
* Trims and slices to 72 chars before escaping; escaping can lengthen the string (e.g. `%` → `%25`),
* so validation may fail if the escaped result exceeds 72 chars.
* Use {@link decodeGhOutputTitle} when reading the title back from parsed GITHUB_OUTPUT.
*/
function sanitizeForGhOutput(s) {
	const escaped = s.trim().slice(0, 72).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
	return Result.try({
		try: () => Schema.decodeSync(GhOutputValueSchema)(escaped),
		catch: (e) => /* @__PURE__ */ new Error(`GITHUB_OUTPUT value exceeds 72 chars after escaping: ${e instanceof Error ? e.message : String(e)}`)
	});
}
/** Check if string is empty or whitespace-only. */
function isBlank(s) {
	return s.trim().length === 0;
}
/** Check if HTTP status indicates error (4xx or 5xx). */
function isHttpError(status) {
	return status >= 400;
}
/** Parse newline-separated subjects from file content. */
function parseSubjects(content) {
	return content.split("\n").map((s) => s.trim()).filter(Boolean);
}
/** Trim quotes and surrounding whitespace from Ollama response. */
function trimOllamaResponse(s) {
	return s.replace(/^"|"$/g, "").replace(/^\s+|\s+$/g, "");
}
/** Build full description prompt from template and commit content. */
function buildDescriptionPrompt(promptTemplate, commitContent) {
	return `${promptTemplate.trim()}\n\nCommits:\n${commitContent}`;
}
/** Parse Ollama response: line 1 = title, line 2 = blank, line 3+ = description. */
function parseTitleDescriptionResponse(raw) {
	const t = trimOllamaResponse(raw);
	if (!t || t === "null") return Result.fail(new OllamaDescriptionInvalidError({ cause: "empty" }));
	const lines = t.split("\n");
	const title = lines[0]?.trim();
	const description = lines.slice(2).join("\n").trim();
	if (!title || !description) return Result.fail(new OllamaDescriptionInvalidError({ cause: "title or description missing (expected: line 1 = title, line 2 = blank, line 3+ = description)" }));
	return Result.succeed({
		title,
		description
	});
}
/** Parse key=value lines from GITHUB_OUTPUT content into a record. */
function parseGhOutput(content) {
	const result = {};
	for (const line of content.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) {
			const key = line.slice(0, eq);
			result[key] = line.slice(eq + 1);
		}
	}
	return result;
}
/** Get value from parsed GITHUB_OUTPUT. Fails when key is absent. */
function getGhOutputValue(parsed, key) {
	const value = parsed[key];
	if (value === void 0) return Result.fail(/* @__PURE__ */ new Error(`GITHUB_OUTPUT missing key: ${key}`));
	return Result.succeed(value);
}
/**
* Decode percent-encoded title from GITHUB_OUTPUT.
*
* When writing to GITHUB_OUTPUT, {@link sanitizeForGhOutput} encodes `%` → `%25`, `\n` → `%0A`, `\r` → `%0D`.
* When reading the file (e.g. in run-auto-pr), we get the raw encoded string. This reverses that encoding
* so the title can be passed to `gh pr create` / `gh pr edit`.
* Fails when raw is absent (undefined or blank).
*/
function decodeGhOutputTitle(raw) {
	if (raw.trim() === "") return Result.fail(/* @__PURE__ */ new Error("GITHUB_OUTPUT title is absent"));
	try {
		return Result.succeed(decodeURIComponent(raw));
	} catch (e) {
		return Result.fail(/* @__PURE__ */ new Error(`Failed to decode GITHUB_OUTPUT title: ${e instanceof Error ? e.message : String(e)}`));
	}
}
/** Validate get-commits GITHUB_OUTPUT. Returns Result with commits and files paths. */
function validateGetCommitsOutput(parsed) {
	return pipe(getGhOutputValue(parsed, "commits"), Result.flatMap((commits) => pipe(getGhOutputValue(parsed, "files"), Result.flatMap((files) => isBlank(commits) || isBlank(files) ? Result.fail(/* @__PURE__ */ new Error("Get commits did not output commits and files")) : Result.succeed({
		commits,
		files
	})))));
}
/** Validate generate-content GITHUB_OUTPUT. Returns Result with title and body_file. */
function validateGenerateContentOutput(parsed) {
	return pipe(getGhOutputValue(parsed, "title"), Result.flatMap((titleRaw) => pipe(getGhOutputValue(parsed, "body_file"), Result.flatMap((bodyFile) => isBlank(bodyFile) ? Result.fail(/* @__PURE__ */ new Error("Generate content did not output title and body_file")) : pipe(decodeGhOutputTitle(titleRaw), Result.flatMap((title) => isBlank(title) ? Result.fail(/* @__PURE__ */ new Error("Generate content did not output title and body_file")) : Result.succeed({
		title,
		bodyFile
	})))))));
}
/** Build GITHUB_OUTPUT entries for get-commits step. */
function buildGetCommitsGhEntries(commitsPath, filesPath, semanticCount) {
	return [
		{
			key: "commits",
			value: commitsPath
		},
		{
			key: "files",
			value: filesPath
		},
		{
			key: "count",
			value: String(semanticCount)
		}
	];
}
/** Build GITHUB_OUTPUT entries for generate-content step. */
function buildGenerateContentGhEntries(title, bodyPath) {
	return pipe(sanitizeForGhOutput(title), Result.map((sanitized) => [{
		key: "title",
		value: sanitized
	}, {
		key: "body_file",
		value: bodyPath
	}]));
}
Schema.Struct({
	logFilePath: Schema.String,
	filesFilePath: Schema.String,
	templatePath: Schema.String,
	descriptionFilePath: Schema.optionalKey(Schema.String),
	howToTestDefault: Schema.String
});
//#endregion
//#region src/lib/collapse-prose-paragraphs.ts
/** Fallback when remark parsing fails: collapse newlines within paragraphs. */
function fallback(text) {
	return text.split(/\n\n+/).map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
}
/** Pure: map phrasing content, collapsing breaks and normalizing text. */
function collapsePhrasingContent(child) {
	if (child.type === "break") return {
		type: "text",
		value: " "
	};
	if (child.type === "text") return {
		...child,
		value: child.value.replace(/\n/g, " ")
	};
	return child;
}
/** Pure: transform paragraph children (breaks → space, text newlines → space). */
function collapseParagraphChildren(children) {
	return children.map(collapsePhrasingContent);
}
function collapseParagraphBreaks() {
	return (tree) => {
		visit(tree, "paragraph", (node) => {
			node.children = collapseParagraphChildren(node.children);
		});
	};
}
const processor = remark().use(collapseParagraphBreaks);
/**
* Collapse newlines within prose paragraphs. Lists and code blocks preserved.
* Falls back to heuristic on parse error.
*/
function collapseProseParagraphs(text) {
	if (isBlank(text)) return text;
	try {
		const result = processor.processSync(text);
		return String(result).trim();
	} catch {
		return fallback(text);
	}
}
//#endregion
//#region src/lib/fill-pr-template-core.ts
const CONVENTIONAL_TYPES = [
	"feat",
	"fix",
	"docs",
	"security",
	"chore",
	"ci",
	"build",
	"refactor",
	"style",
	"test",
	"perf",
	"revert"
];
const ISSUE_STARTS_PATTERN = /^(Closes|Fixes|Fix|Resolves|Resolve|Closed|Close) #\d+/i;
const TYPE_MAP = {
	feat: "New feature",
	fix: "Bug fix",
	docs: "Documentation update",
	security: "Security fix",
	chore: "Chore",
	ci: "Chore",
	build: "Chore",
	refactor: "Chore",
	style: "Chore",
	test: "Chore",
	perf: "Chore",
	revert: "Chore"
};
const parser = new CommitParser();
function toError(e) {
	return e instanceof Error ? e : new Error(String(e));
}
function isConventionalType(s) {
	return CONVENTIONAL_TYPES.some((t) => t === s);
}
function typeFromString(s) {
	if (!s) return "Chore";
	const lower = s.toLowerCase();
	return isConventionalType(lower) ? TYPE_MAP[lower] : "Chore";
}
function mapParsedToCommitInfo(block, parsed) {
	const header = parsed.header ?? block.split("\n")[0] ?? "";
	const body = [parsed.body, parsed.footer].filter(Boolean).join("\n\n").trim();
	const refs = parsed.references.map((r) => {
		return `${r.action ?? "Closes"} ${r.owner != null && r.repository != null ? `${r.owner}/${r.repository}#${r.issue}` : `${r.prefix ?? "#"}${r.issue}`}`;
	});
	const breaking = parsed.notes.find((n) => /BREAKING/i.test(n.title));
	return {
		subject: header,
		body,
		fullMessage: block,
		type: parsed.type ?? null,
		references: refs,
		breakingNote: breaking?.text ?? null
	};
}
function parseCommits(logOutput) {
	return Result.try({
		try: () => {
			return logOutput.split("---COMMIT---").map((b) => b.trim()).filter(Boolean).map((block) => mapParsedToCommitInfo(block, parser.parse(block)));
		},
		catch: (e) => new ParseError({
			message: "Failed to parse commits",
			cause: toError(e)
		})
	});
}
function inferTypeOfChange(commits) {
	if (commits.some((c) => c.breakingNote != null)) return "Breaking change";
	const first = commits[0];
	if (!first) return "Chore";
	const sub = first.subject;
	if (/^feat!|^feat\(.*\)!:|^BREAKING/.test(sub)) return "Breaking change";
	const fromType = typeFromString(first.type);
	if (fromType !== "Chore") return fromType;
	return typeFromString(sub.toLowerCase().split(":")[0] ?? "");
}
function getTitle(commits) {
	return commits[0]?.subject ?? "";
}
const CONVENTIONAL_HEADER_PATTERN = /^(\w+)(?:\([^)]*\))?!?: .+$/;
function isValidConventionalTitle(s) {
	if (isBlank(s) || s.trim().length > 72) return false;
	return CONVENTIONAL_HEADER_PATTERN.test(s.trim());
}
function getDescription(first) {
	const body = first.body.trim();
	const firstLine = body.split("\n")[0] ?? "";
	if (body && !ISSUE_STARTS_PATTERN.test(firstLine)) return collapseProseParagraphs(body.split("\n").slice(0, 20).join("\n"));
	const captured = /^[^:]+:\s*(.+)$/.exec(first.subject)?.[1];
	return captured != null ? captured.trim() : first.subject;
}
function getDescriptionFromCommits(commits) {
	return commits.map((c) => getDescription(c)).filter((s) => !isBlank(s)).join("\n\n");
}
function getDescriptionPromptText(commits) {
	return commits.map((c) => {
		return `- ${c.body.trim() ? `${c.subject}\n\n${c.body}` : c.subject}`;
	}).join("\n\n");
}
function getChanges(commits) {
	return commits.filter((c) => c.subject).map((c) => `- ${c.subject}`);
}
function isDocsFile(f) {
	return f.endsWith(".md") || f.startsWith("docs/");
}
function isDocsOnly(files) {
	return files.length === 0 || files.every(isDocsFile);
}
function hasTestFiles(files) {
	return files.some((f) => f.endsWith(".test.ts") || f.endsWith(".spec.ts") || /\/test\//.test(f) || /\/spec\//.test(f));
}
function hasDocsFiles(files) {
	return files.some(isDocsFile);
}
function isConventional(commit) {
	return commit.type != null;
}
function isMergeCommit(c) {
	return isMergeCommitSubject(c.subject);
}
function filterMergeCommits(commits) {
	return commits.filter((c) => !isMergeCommit(c));
}
/** Parse newline-separated file paths from content. Uses parseSubjects from core. */
function parseFilesContent(content) {
	return parseSubjects(content);
}
/** Check if body contains unreplaced {{placeholder}}s. */
function hasUnreplacedPlaceholders(body) {
	return body.includes("{{");
}
/** Format title and body as single string (title-body output format). */
function formatTitleBody(title, body) {
	return `${title}\n\n${body}`;
}
function getRelatedIssues(commits) {
	return pipe(commits, (commits) => commits.flatMap((c) => c.references), (refs) => [...new Set(refs)].toSorted());
}
function getBreakingChanges(commits) {
	return pipe(Arr.findFirst(commits, (c) => c.breakingNote != null), Option.map((c) => c.breakingNote.trim().slice(0, 2e3)));
}
function getHowToTest(files, howToTestDefault) {
	if (isDocsOnly(files)) return Result.succeed("N/A");
	if (howToTestDefault !== void 0 && howToTestDefault.trim() !== "") return Result.succeed(howToTestDefault);
	return Result.fail(new FillPrTemplateValidationError({ message: "howToTestDefault is required when not docs-only" }));
}
function fillTemplate(commits, files, descriptionOverride, howToTestDefault) {
	return pipe(getHowToTest(files, howToTestDefault), Result.map((howToTest) => {
		const typeOfChange = inferTypeOfChange(commits);
		const description = descriptionOverride !== void 0 && descriptionOverride !== "" ? descriptionOverride : getDescriptionFromCommits(commits);
		const changes = commits.length ? getChanges(commits) : ["- "];
		const breaking = pipe(getBreakingChanges(commits), Option.getOrElse(() => ""));
		return {
			description,
			typeOfChange,
			changes,
			howToTest,
			commitsConventional: commits.length > 0 && commits.every(isConventional),
			docsUpdated: hasDocsFiles(files),
			testsAdded: hasTestFiles(files),
			relatedIssues: getRelatedIssues(commits),
			breakingChanges: typeOfChange === "Breaking change" ? breaking : ""
		};
	}));
}
function buildSubstitutionScope(data) {
	const conv = data.commitsConventional ? "x" : " ";
	const docs = data.docsUpdated ? "x" : " ";
	const tests = data.testsAdded ? "x" : " ";
	return {
		description: data.description,
		typeOfChange: data.typeOfChange,
		changes: data.changes.length ? data.changes.join("\n") : "- ",
		howToTest: data.howToTest,
		checklistConventional: conv,
		checklistDocs: docs,
		checklistTests: tests,
		relatedIssues: data.relatedIssues.length ? data.relatedIssues.join("\n") : "",
		breakingChanges: data.breakingChanges || "",
		placeholder: "placeholder"
	};
}
/**
* Fill template from commits and files, then render with micromustache.
* Can throw on malformed template syntax (e.g. `{{}}`, `{{a{{b}}`).
*/
function renderBody$1(commits, files, template, descriptionOverride, howToTestDefault) {
	return pipe(fillTemplate(commits, files, descriptionOverride, howToTestDefault), Result.flatMap((data) => Result.try({
		try: () => render(template, buildSubstitutionScope(data)),
		catch: (e) => new TemplateRenderError({
			message: "Failed to render template",
			cause: toError(e)
		})
	})));
}
//#endregion
//#region src/auto-pr/live/fill-pr-template.ts
/**
* Live FillPrTemplate interpreter. Uses fill-pr-template core, FileSystem, and Path.
*/
/** Effect wrapper: calls pure renderBody, logs if unreplaced placeholders remain. */
const renderBody = Effect.fn("renderBody")(function* (commits, files, template, descriptionOverride, howToTestDefault) {
	const bodyResult = renderBody$1(commits, files, template, descriptionOverride, howToTestDefault);
	const body = yield* Effect.fromResult(bodyResult);
	return hasUnreplacedPlaceholders(body) ? yield* Effect.gen(function* () {
		yield* Effect.logWarning({
			event: "fill_pr_template",
			message: "Output contains unreplaced {{placeholder}}s"
		});
		return body;
	}) : body;
});
/** Resolve template path. Requires templatePath (no default). */
function resolveTemplatePath(pathApi, cwd, templatePath) {
	return pathApi.isAbsolute(templatePath) ? templatePath : pathApi.resolve(cwd, templatePath);
}
function readTemplate(filePath) {
	return pipe(FileSystem.FileSystem.asEffect(), Effect.flatMap((fs) => fs.readFileString(filePath).pipe(mapFsError(filePath, "readFileString"))));
}
function readLogAndFiles(logFilePath, filesFilePath) {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem.asEffect();
		const [logContent, filesContent] = yield* Effect.all([fs.readFileString(logFilePath).pipe(mapFsError(logFilePath, "readFileString")), fs.readFileString(filesFilePath).pipe(mapFsError(filesFilePath, "readFileString"))]);
		return [logContent, parseFilesContent(filesContent)];
	});
}
function loadTemplateAndParams(params) {
	return Effect.gen(function* () {
		if (params.templatePath === void 0 || params.templatePath.trim() === "") return yield* Effect.fail(new FillPrTemplateValidationError({ message: "templatePath is required" }));
		const template = yield* readTemplate(resolveTemplatePath(yield* Path.Path, yield* Effect.sync(() => process.cwd()), params.templatePath));
		const [logContent, files] = yield* readLogAndFiles(params.logFilePath, params.filesFilePath);
		const parseResult = parseCommits(logContent);
		const commits = filterMergeCommits(yield* Effect.fromResult(parseResult));
		let descriptionOverride;
		if (params.descriptionFilePath) descriptionOverride = yield* (yield* FileSystem.FileSystem.asEffect()).readFileString(params.descriptionFilePath).pipe(mapFsError(params.descriptionFilePath, "readFileString"));
		return {
			template,
			commits,
			files,
			descriptionOverride,
			howToTestDefault: params.howToTestDefault
		};
	});
}
/** FillPrTemplate service tag. */
var FillPrTemplate = class FillPrTemplate extends ServiceMap.Service()("auto-pr/fill-pr-template") {
	/** Live layer for FillPrTemplate. No dependencies. */
	static Live = Layer.effect(FillPrTemplate, Effect.gen(function* () {
		const getTitle$1 = Effect.fn("FillPrTemplate.getTitle")(function* (params) {
			yield* Effect.log({
				event: "fill_pr_template",
				status: "getTitle",
				logFile: redactPath(params.logFilePath),
				filesFile: redactPath(params.filesFilePath)
			});
			const [logContent, _files] = yield* readLogAndFiles(params.logFilePath, params.filesFilePath);
			const parseResult = parseCommits(logContent);
			const title = getTitle(filterMergeCommits(yield* Effect.fromResult(parseResult)));
			if (!title.trim()) return yield* Effect.fail(new PullRequestTitleBlankError({ message: "PR title is empty. Add at least one non-merge commit with non-empty subject (e.g. feat: add X) before pushing." }));
			return title;
		});
		const getBody = Effect.fn("FillPrTemplate.getBody")(function* (params) {
			if (params.templatePath === void 0 || params.templatePath.trim() === "") return yield* Effect.fail(new FillPrTemplateValidationError({ message: "templatePath is required" }));
			const resolvedPath = resolveTemplatePath(yield* Path.Path, yield* Effect.sync(() => process.cwd()), params.templatePath);
			yield* Effect.log({
				event: "fill_pr_template",
				status: "getBody",
				logFile: redactPath(params.logFilePath),
				filesFile: redactPath(params.filesFilePath),
				templatePath: redactPath(resolvedPath)
			});
			const { template, commits, files, descriptionOverride, howToTestDefault } = yield* loadTemplateAndParams(params);
			const body = yield* renderBody(commits, files, template, descriptionOverride, howToTestDefault);
			if (!body.trim()) return yield* Effect.fail(new PullRequestBodyBlankError({ message: "PR body is empty. Add at least one non-merge commit with a non-empty body before pushing." }));
			yield* Effect.log({
				event: "fill_pr_template",
				status: "getBody_succeeded",
				commitsCount: commits.length,
				filesCount: files.length
			});
			return body;
		});
		return FillPrTemplate.of({
			getTitle: getTitle$1,
			getBody
		});
	}));
};
//#endregion
//#region src/auto-pr/paths.ts
/**
* Path resolution for package-relative assets. Uses Effect Path service.
*/
/** Resolve path to pr-description.txt prompt (package-relative). Uses Path service. */
const getPrDescriptionPromptPath = Effect.fn("getPrDescriptionPromptPath")(function* () {
	const pathApi = yield* Path.Path;
	const scriptPath = yield* pathApi.fromFileUrl(new URL(import.meta.url));
	return pathApi.join(pathApi.dirname(scriptPath), "prompts", "pr-description.txt");
});
//#endregion
//#region src/auto-pr/shell.ts
/**
* Shared shell (Effect) for auto-PR scripts. I/O, exec, layers.
*/
/** Platform layer for auto-PR scripts: FileSystem + Path. */
const PlatformLayer = NodeFileSystem.layer.pipe(Layer.provideMerge(NodePath.layer));
/** ChildProcessSpawner layer (requires FileSystem + Path). */
const ChildProcessSpawnerLayer = NodeChildProcessSpawner.layer.pipe(Layer.provide(PlatformLayer));
/** Run a command and return stdout. Maps PlatformError to PullRequestFailedError. */
const runCommand = Effect.fn("runCommand")(function* (command, args, cwd) {
	return yield* (yield* ChildProcessSpawner).string(ChildProcess.make(command, args, { cwd })).pipe(Effect.mapError((e) => new PullRequestFailedError({ cause: String(e) })));
});
/** Append entries to GITHUB_OUTPUT file. */
const appendGhOutput = Effect.fn("appendGhOutput")(function* (path, entries) {
	const fs = yield* FileSystem.FileSystem;
	const content = formatGhOutput(entries);
	yield* fs.writeFileString(path, content, { flag: "a" });
});
/** Logger layer for auto-PR scripts. Respects NO_COLOR. */
const AutoPrLoggerLayer = Logger.layer([Logger.consolePretty({ colors: process.env.NO_COLOR === void 0 })]).pipe(Layer.provide(Layer.succeed(Logger.LogToStderr)(true)));
/** Debug hint for error output when AUTO_PR_DEBUG is not set. Reads process.env. */
function getDebugHint() {
	return process.env.AUTO_PR_DEBUG === "1" || process.env.AUTO_PR_DEBUG === "true" ? "" : " Set AUTO_PR_DEBUG=1 for verbose output.";
}
/** Run main with NodeRuntime. Provides Logger, logs errors, exits 0/1. Call from `if (import.meta.main)`. */
function runMain(program, eventName) {
	NodeRuntime.runMain(program.pipe(Effect.provide(AutoPrLoggerLayer), Effect.tapError((e) => Effect.logError({
		event: eventName,
		error: formatError(e) + getDebugHint()
	}))));
}
//#endregion
export { CreateOrUpdatePrConfigLayer as A, NoSemanticCommitsError as B, parseGhOutput as C, validateGenerateContentOutput as D, trimOllamaResponse as E, GetCommitsConfig as F, formatError as H, GetCommitsConfigLayer as I, RunAutoPrConfig as L, FillPrTemplateConfigLayer as M, GeneratePrContentConfig as N, validateGetCommitsOutput as O, GeneratePrContentConfigLayer as P, RunAutoPrConfigLayer as R, isHttpError as S, parseTitleDescriptionResponse as T, mapFsError as U, OllamaHttpError as V, redactPath as W, renderBody$1 as _, runCommand as a, buildGetCommitsGhEntries as b, FillPrTemplate as c, getDescriptionFromCommits as d, getDescriptionPromptText as f, parseFilesContent as g, parseCommits as h, appendGhOutput as i, FillPrTemplateConfig as j, CreateOrUpdatePrConfig as k, filterMergeCommits as l, isValidConventionalTitle as m, ChildProcessSpawnerLayer as n, runMain as o, getTitle as p, PlatformLayer as r, getPrDescriptionPromptPath as s, AutoPrLoggerLayer as t, formatTitleBody as u, buildDescriptionPrompt as v, parseSubjects as w, filterSemanticSubjects as x, buildGenerateContentGhEntries as y, BodyFileNotFoundError as z };

//# sourceMappingURL=auto-pr-DkfFR68I.mjs.map