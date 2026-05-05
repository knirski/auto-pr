import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { rewriteLinks } from "./copy-docs-core.js";

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
const EXCLUDED_ADR_FILES = new Set(["adr-template.md"]);

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Untitled";
}

function buildFrontmatter(title: string, meta?: DocMeta, editUrl?: string): string {
  const lines = ["---", `title: "${title}"`];
  if (editUrl) {
    lines.push(`editUrl: "${editUrl}"`);
  }
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
  repoRelativePath?: string,
): Promise<void> {
  const raw = await readFile(srcPath, "utf-8");
  const title = extractTitle(raw);
  const editUrl = repoRelativePath
    ? `https://github.com/knirski/auto-pr/edit/main/${repoRelativePath}`
    : undefined;
  const frontmatter = buildFrontmatter(title, meta, editUrl);
  const sourceDir = repoRelativePath ? posix.dirname(repoRelativePath) : "docs";
  const rewritten = rewriteLinks(stripH1(raw), sourceDir);
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
    await processFile(
      join(DOCS_DIR, file),
      join(OUTPUT_DIR, destName),
      docsMeta[file],
      `docs/${file}`,
    );
  }

  // Process ADRs
  const adrDir = join(DOCS_DIR, "adr");
  const adrFiles = await readdir(adrDir);
  for (const file of adrFiles) {
    if (!file.endsWith(".md")) continue;
    if (EXCLUDED_ADR_FILES.has(file)) continue;
    const destName = file === "README.md" ? "index.md" : file.toLowerCase();
    await processFile(
      join(adrDir, file),
      join(OUTPUT_DIR, "adr", destName),
      undefined,
      `docs/adr/${file}`,
    );
  }

  const topCount = topLevel.filter((f) => f.endsWith(".md") && !EXCLUDED_FILES.has(f)).length;
  const adrCount = adrFiles.filter((f) => f.endsWith(".md") && !EXCLUDED_ADR_FILES.has(f)).length;
  process.stdout.write(`Copied ${topCount} docs + ${adrCount} ADRs → ${OUTPUT_DIR}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
