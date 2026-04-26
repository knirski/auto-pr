import { posix } from "node:path";

const SITE_BASE = "/auto-pr/";
const REPO_BLOB_BASE = "https://github.com/knirski/auto-pr/blob/main/";
const EXCLUDED_FILES = new Set(["README.md"]);
const EXCLUDED_ADR_FILES = new Set(["adr-template.md"]);

function isExternalHref(href: string): boolean {
	return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href);
}

function splitHref(href: string): readonly [path: string, anchor: string] {
	const [path = "", anchor = ""] = href.split("#", 2);
	return [path, anchor];
}

function normalizeRepoPath(sourceDir: string, hrefPath: string): string {
	const rawPath = hrefPath.startsWith("/") ? hrefPath.slice(1) : posix.join(sourceDir, hrefPath);
	return posix.normalize(rawPath);
}

function routeForPublishedMarkdown(repoPath: string): string | undefined {
	if (repoPath.startsWith("docs/adr/")) {
		const file = repoPath.slice("docs/adr/".length);
		if (!file.endsWith(".md") || file.includes("/") || EXCLUDED_ADR_FILES.has(file)) {
			return undefined;
		}
		return file === "README.md"
			? `${SITE_BASE}adr/`
			: `${SITE_BASE}adr/${file.replace(/\.md$/, "").toLowerCase()}/`;
	}

	if (repoPath.startsWith("docs/")) {
		const file = repoPath.slice("docs/".length);
		if (!file.endsWith(".md") || file.includes("/") || EXCLUDED_FILES.has(file)) {
			return undefined;
		}
		const slug = file.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-");
		return `${SITE_BASE}${slug}/`;
	}

	return undefined;
}

function hrefForRepoPath(repoPath: string, anchor: string): string {
	const anchorSuffix = anchor ? `#${anchor}` : "";
	const siteRoute = routeForPublishedMarkdown(repoPath);
	if (siteRoute) {
		return `${siteRoute}${anchorSuffix}`;
	}

	return `${REPO_BLOB_BASE}${repoPath}${anchorSuffix}`;
}

export function rewriteLinks(content: string, sourceDir: string): string {
	return content.replace(/\]\(([^)]+)\)/g, (full, href: string) => {
		if (isExternalHref(href)) {
			return full;
		}

		const [hrefPath, anchor] = splitHref(href);
		if (!hrefPath) return full;
		const repoPath = normalizeRepoPath(sourceDir, hrefPath);
		return `](${hrefForRepoPath(repoPath, anchor)})`;
	});
}
