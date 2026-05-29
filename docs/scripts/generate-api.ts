// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kebab, packageSlug } from "./lib/kebab.js";
import { discoverPackages, type PackageRegistry } from "./lib/registry.js";
import {
  getOwnExportGroups,
  renderPackageOverview,
  sanitizePackageSummary,
} from "./lib/render-package.js";
import { renderMeta, type MetaEntry } from "./lib/write-meta.js";
import { Kind, type Declaration, type Project } from "./lib/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = resolve(__dirname, "..");
const PACKAGES_DIR = resolve(DOCS_ROOT, "..", "product-sdk", "packages");
const API_JSON = join(DOCS_ROOT, "generated/api.json");
const API_CONTENT = join(DOCS_ROOT, "content/api");

// The on-disk folder for a package, looked up from the workspace registry.
// Falls back to deriving the folder from the package name if a TypeDoc-emitted
// package isn't in the registry (shouldn't happen — guards a future scenario
// where TypeDoc surfaces a package that lacks a discoverable package.json).
function ownFolderFor(pkg: Declaration, registry: PackageRegistry): string {
  const folder = registry.nameToFolder.get(pkg.name);
  if (folder) return folder;
  if (pkg.name === "@parity/product-sdk") return "sdk";
  return pkg.name.replace(/^@parity\/product-sdk-/, "");
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

function labelFor(item: Declaration): string {
  return item.kind === Kind.Function ? `${item.name}()` : item.name;
}

// Build the per-package sidebar: symbols grouped by kind with separator
// headers, each symbol linking to an anchor on the package's own page so
// navigation stays within the single consolidated document.
function buildPackageSidebar(
  pkg: Declaration,
  ownFolder: string,
  slug: string,
  registry: PackageRegistry,
): MetaEntry[] {
  const groups = getOwnExportGroups(pkg, ownFolder, registry);
  // "Overview" points back to the package page itself (without a fragment),
  // so clicking it takes the reader to the top of the consolidated page.
  // Without this entry, Nextra labels the index page by its frontmatter
  // title, which duplicates the parent folder label.
  const entries: MetaEntry[] = [{ key: "index", label: "Overview" }];
  const seenKeys = new Set<string>(["index"]);
  for (const group of groups) {
    for (const item of group.items) {
      const key = kebab(item.name);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      entries.push({
        key,
        value: { title: labelFor(item), href: `/api/${slug}/#${key}` },
      });
    }
  }
  return entries;
}

async function generateForPackage(
  pkg: Declaration,
  registry: PackageRegistry,
): Promise<string> {
  const slug = packageSlug(pkg.name);
  const ownFolder = ownFolderFor(pkg, registry);
  const pkgDir = join(API_CONTENT, slug);

  const overview = renderPackageOverview(pkg, ownFolder, registry);
  await writeFileAtomic(join(pkgDir, "index.mdx"), overview);

  const sidebar = buildPackageSidebar(pkg, ownFolder, slug, registry);
  await writeFileAtomic(join(pkgDir, "_meta.ts"), renderMeta(sidebar));

  return slug;
}

function renderApiLandingPage(
  packages: { slug: string; name: string; summary: string }[],
): string {
  const sorted = packages.slice().sort((a, b) => {
    if (a.slug === "sdk") return -1;
    if (b.slug === "sdk") return 1;
    return a.slug.localeCompare(b.slug);
  });
  const lines = [
    "---",
    "generated: true",
    'title: "API Reference"',
    'description: "Reference documentation for every package in @parity/product-sdk."',
    "---",
    "",
    "# API Reference",
    "",
    "Reference documentation for every package in `@parity/product-sdk`. Start with the umbrella package for app-level primitives like `createApp`, or jump into a leaf package for focused functionality.",
    "",
    "| Package | Summary |",
    "| --- | --- |",
  ];
  for (const pkg of sorted) {
    const summary = (pkg.summary || "—").replace(/\s+/g, " ").replace(/\|/g, "\\|");
    lines.push(`| [\`${pkg.name}\`](/api/${pkg.slug}) | ${summary} |`);
  }
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const project = JSON.parse(readFileSync(API_JSON, "utf8")) as Project;
  if (!project.children || project.children.length === 0) {
    throw new Error("No packages in TypeDoc JSON — did docs:extract run?");
  }

  // Discover the workspace package registry once. This drives folder ↔ name
  // resolution everywhere else, replacing what used to be a hardcoded list of
  // folder names.
  const registry = discoverPackages(PACKAGES_DIR);
  if (registry.folders.size === 0) {
    throw new Error(`No documentable packages discovered in ${PACKAGES_DIR}`);
  }

  // Nuke-and-repave the generated tree. Everything under content/api/ is
  // generator-owned so stale artifacts never drift across runs.
  if (existsSync(API_CONTENT)) rmSync(API_CONTENT, { recursive: true, force: true });

  const packageInfos: { slug: string; name: string; summary: string }[] = [];
  for (const pkg of project.children) {
    const slug = await generateForPackage(pkg, registry);
    const rawSummary = (pkg.comment?.summary ?? [])
      .map((p) => ("text" in p ? (p as { text: string }).text : ""))
      .join("");
    const cleaned = sanitizePackageSummary(rawSummary, pkg.name);
    const firstLine = cleaned.split(/\r?\n/)[0]?.trim() ?? "";
    packageInfos.push({ slug, name: pkg.name, summary: firstLine });
  }
  const slugs = packageInfos.map((p) => p.slug);

  // Root api _meta.ts: landing page, umbrella pinned first, then leaves
  // alphabetically. Each package slug maps to its folder; Nextra expands the
  // folder in the sidebar to show the symbol anchors from the nested _meta.ts.
  slugs.sort((a, b) => {
    if (a === "sdk") return -1;
    if (b === "sdk") return 1;
    return a.localeCompare(b);
  });
  const rootMeta: MetaEntry[] = [
    { key: "index", label: "Overview" },
    ...slugs.map((slug) => ({
      key: slug,
      label: slug === "sdk" ? "@parity/product-sdk" : `@parity/product-sdk-${slug}`,
    })),
  ];
  await writeFileAtomic(join(API_CONTENT, "_meta.ts"), renderMeta(rootMeta));
  await writeFileAtomic(
    join(API_CONTENT, "index.mdx"),
    renderApiLandingPage(packageInfos),
  );

  console.log(`Generated API reference for ${slugs.length} package(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
