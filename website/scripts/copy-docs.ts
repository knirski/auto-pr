import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const OUTPUT_DIR = join(import.meta.dirname, "..", "src", "content", "docs");

interface DocMeta {
	order: number;
	label?: string;
}

const docsMeta: Record<string, DocMeta> = {
	"INTEGRATION.md": { order: 1, label: "Getting Started" },
	"TROUBLESHOOTING.md": { order: 2 },
	"PR_TEMPLATE.md": { order: 3, label: "PR Template Placeholders" },
	"ARCHITECTURE.md": { order: 10 },
	"CI.md": { order: 11, label: "CI & Workflows" },
	"WORKFLOW_SECURITY.md": { order: 12 },
	"CII.md": { order: 13, label: "CII Best Practices" },
};

const EXCLUDED_FILES = new Set(["README.md"]);

function extractTitle(content: string): string {
	const match = content.match(/^#\s+(.+)$/m);
	return match ? match[1].trim() : "Untitled";
}

function rewriteLinks(content: string, subdir: string = ""): string {
	return content.replace(/\]\(([^)]+)\)/g, (full, href: string) => {
		if (href.startsWith("http") || href.startsWith("#") || href.startsWith("../")) {
			return full;
		}

		const [filePart, anchor] = href.split("#");
		if (!filePart?.endsWith(".md")) {
			return full;
		}

		const slug = filePart.replace(/\.md$/, "").toLowerCase().replace(/_/g, "-");

		// For relative links (no directory component), prepend the subdir
		const prefix = filePart.includes("/") ? "" : subdir;
		const anchorSuffix = anchor ? `#${anchor}` : "";
		return `](/auto-pr/${prefix}${slug}/${anchorSuffix})`;
	});
}

function buildFrontmatter(title: string, meta?: DocMeta): string {
	const lines = ["---", `title: "${title}"`];
	if (meta?.label) {
		lines.push(`sidebar:`);
		lines.push(`  label: "${meta.label}"`);
		lines.push(`  order: ${meta.order}`);
	} else if (meta) {
		lines.push(`sidebar:`);
		lines.push(`  order: ${meta.order}`);
	}
	lines.push("---", "");
	return lines.join("\n");
}

function stripH1(content: string): string {
	return content.replace(/^#\s+.+\n+/, "");
}

async function processFile(
	srcPath: string,
	destPath: string,
	meta?: DocMeta,
	subdir: string = "",
): Promise<void> {
	const raw = await readFile(srcPath, "utf-8");
	const title = extractTitle(raw);
	const frontmatter = buildFrontmatter(title, meta);
	const rewritten = rewriteLinks(stripH1(raw), subdir);
	await mkdir(dirname(destPath), { recursive: true });
	await writeFile(destPath, frontmatter + rewritten);
}

async function main(): Promise<void> {
	// Clean output directory (except .gitkeep)
	const existing = await readdir(OUTPUT_DIR, { recursive: true }).catch(() => []);
	for (const entry of existing) {
		if (entry === ".gitkeep") continue;
		const full = join(OUTPUT_DIR, entry);
		await rm(full, { recursive: true, force: true }).catch(() => {});
	}

	// Process top-level docs
	const topLevel = await readdir(DOCS_DIR);
	for (const file of topLevel) {
		if (!file.endsWith(".md") || EXCLUDED_FILES.has(file)) continue;
		const destName = file.toLowerCase().replace(/_/g, "-");
		await processFile(join(DOCS_DIR, file), join(OUTPUT_DIR, destName), docsMeta[file]);
	}

	// Process ADRs
	const adrDir = join(DOCS_DIR, "adr");
	const adrFiles = await readdir(adrDir);
	for (const file of adrFiles) {
		if (!file.endsWith(".md")) continue;
		if (file === "adr-template.md") continue;
		const destName = file === "README.md" ? "index.md" : file.toLowerCase();
		await processFile(join(adrDir, file), join(OUTPUT_DIR, "adr", destName), undefined, "adr/");
	}

	const topCount = topLevel.filter((f) => f.endsWith(".md") && !EXCLUDED_FILES.has(f)).length;
	const adrCount = adrFiles.filter((f) => f.endsWith(".md") && f !== "adr-template.md").length;
	process.stdout.write(`Copied ${topCount} docs + ${adrCount} ADRs → ${OUTPUT_DIR}\n`);
}

main().catch((err) => {
	process.stderr.write(`${String(err)}\n`);
	process.exit(1);
});
