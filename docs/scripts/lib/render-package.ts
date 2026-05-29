// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { kebab } from "./kebab.js";
import {
  isOwnExport,
  originPackageFolder,
  packageFolderToSlug,
} from "./reexports.js";
import type { PackageRegistry } from "./registry.js";
import { firstLine, renderSummary } from "./render-comment.js";
import { renderSymbolSection } from "./render-symbol.js";
import { kindLabel } from "./render-type.js";
import { Kind, type Declaration } from "./types.js";

const SECTION_ORDER: { title: string; groupTitle: string; kind: number }[] = [
  { title: "Classes", groupTitle: "Classes", kind: Kind.Class },
  { title: "Functions", groupTitle: "Functions", kind: Kind.Function },
  { title: "Interfaces", groupTitle: "Interfaces", kind: Kind.Interface },
  { title: "Type Aliases", groupTitle: "Type Aliases", kind: Kind.TypeAlias },
  { title: "Enums", groupTitle: "Enumerations", kind: Kind.Enum },
  { title: "Variables", groupTitle: "Variables", kind: Kind.Variable },
];

export interface OwnExportGroup {
  title: string;
  kind: number;
  items: Declaration[];
}

// Returns the package's own (non-re-exported) children grouped by kind in the
// same order the overview page renders them. Used by both the overview
// renderer and the sidebar _meta.ts builder so the two stay in sync.
export function getOwnExportGroups(
  pkg: Declaration,
  ownFolder: string,
  registry: PackageRegistry,
): OwnExportGroup[] {
  const byId = new Map<number, Declaration>();
  (pkg.children ?? []).forEach((c) => byId.set(c.id, c));
  const ownIds = new Set(
    (pkg.children ?? [])
      .filter((c) => isOwnExport(c, ownFolder, registry))
      .map((c) => c.id),
  );
  const groups = pkg.groups ?? [];
  const result: OwnExportGroup[] = [];
  for (const section of SECTION_ORDER) {
    const group = groups.find((g) => g.title === section.groupTitle);
    if (!group) continue;
    const items = group.children
      .map((id) => byId.get(id))
      .filter(
        (d): d is Declaration => !!d && d.kind === section.kind && ownIds.has(d.id),
      );
    if (items.length === 0) continue;
    result.push({ title: section.title, kind: section.kind, items });
  }
  return result;
}

const escapeYaml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function sanitizePackageSummary(summary: string, pkgName: string): string {
  const lines = summary.split(/\r?\n/);
  while (lines.length > 0) {
    const first = lines[0]!.trim();
    if (first === pkgName || first === "") {
      lines.shift();
    } else {
      break;
    }
  }
  if (lines.length > 0) {
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixPattern = new RegExp(`^${escaped}\\s*[—:\\-]\\s*`);
    lines[0] = lines[0]!.replace(prefixPattern, "");
  }
  return lines.join("\n").trim();
}

function itemSummary(item: Declaration): string {
  const raw = firstLine(
    renderSummary(item.comment) || renderSummary(item.signatures?.[0]?.comment),
  );
  return raw ? raw.replace(/\s+/g, " ").replace(/\|/g, "\\|") : "";
}

function labelFor(item: Declaration): string {
  return item.kind === Kind.Function ? `${item.name}()` : item.name;
}

export function renderPackageOverview(
  pkg: Declaration,
  ownFolder: string,
  registry: PackageRegistry,
): string {
  const rawSummary = renderSummary(pkg.comment);
  const cleanedSummary = sanitizePackageSummary(rawSummary, pkg.name);
  const frontmatterDesc = firstLine(cleanedSummary);

  const lines: string[] = [];
  lines.push("---");
  lines.push("generated: true");
  lines.push(`title: "${escapeYaml(pkg.name)}"`);
  if (frontmatterDesc) lines.push(`description: "${escapeYaml(frontmatterDesc)}"`);
  lines.push("---");
  lines.push("");
  lines.push(`# \`${pkg.name}\``);
  lines.push("");
  if (cleanedSummary) {
    lines.push(cleanedSummary);
    lines.push("");
  }
  lines.push(`\`\`\`sh npm2yarn\nnpm install ${pkg.name}\n\`\`\``);
  lines.push("");
  lines.push("<div data-api-ref>");
  lines.push("");

  const byId = new Map<number, Declaration>();
  (pkg.children ?? []).forEach((c) => byId.set(c.id, c));
  const groups = pkg.groups ?? [];

  const ownChildren = (pkg.children ?? []).filter((c) => isOwnExport(c, ownFolder, registry));
  const reExportChildren = (pkg.children ?? []).filter(
    (c) => !isOwnExport(c, ownFolder, registry),
  );
  const ownIds = new Set(ownChildren.map((c) => c.id));

  // Overview table: same-page anchor links grouped by kind.
  const sectionsWithItems: { title: string; kind: number; items: Declaration[] }[] = [];
  for (const section of SECTION_ORDER) {
    const group = groups.find((g) => g.title === section.groupTitle);
    if (!group) continue;
    const items = group.children
      .map((id) => byId.get(id))
      .filter((d): d is Declaration => !!d && d.kind === section.kind && ownIds.has(d.id));
    if (items.length === 0) continue;
    sectionsWithItems.push({ title: section.title, kind: section.kind, items });
  }

  if (sectionsWithItems.length > 0) {
    lines.push("## Exports");
    lines.push("");
    for (const section of sectionsWithItems) {
      lines.push(`**${section.title}**`);
      lines.push("");
      lines.push("| Name | Summary |");
      lines.push("| --- | --- |");
      for (const item of section.items) {
        const anchor = `#${kebab(item.name)}`;
        const summary = itemSummary(item) || "—";
        lines.push(`| [\`${labelFor(item)}\`](${anchor}) | ${summary} |`);
      }
      lines.push("");
    }
  }

  if (reExportChildren.length > 0) {
    lines.push("## Re-exports");
    lines.push("");
    lines.push(
      "Convenience re-exports from leaf packages. Click through for the canonical documentation.",
    );
    lines.push("");
    lines.push("| Name | Kind | Source package |");
    lines.push("| --- | --- | --- |");
    reExportChildren
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => {
        const folder = originPackageFolder(item, registry);
        const leafSlug = folder ? packageFolderToSlug(folder, registry) : null;
        const leafPkgName = folder ? registry.folderToName.get(folder) ?? null : null;
        const href = leafSlug ? `/api/${leafSlug}/#${kebab(item.name)}` : null;
        const nameCell = href ? `[\`${labelFor(item)}\`](${href})` : `\`${labelFor(item)}\``;
        const kindCell = kindLabel(item.kind);
        const leafPackage =
          leafPkgName && leafSlug ? `[\`${leafPkgName}\`](/api/${leafSlug})` : "—";
        lines.push(`| ${nameCell} | ${kindCell} | ${leafPackage} |`);
      });
    lines.push("");
  }

  // Inline symbol sections grouped by kind, baseLevel=3 under the group ##.
  for (const section of sectionsWithItems) {
    lines.push(`## ${section.title}`);
    lines.push("");
    for (const item of section.items) {
      const body = renderSymbolSection(item, 3);
      if (!body) continue;
      lines.push(body);
      lines.push("");
    }
  }

  // Leftover groups (e.g. References) that aren't in our section order.
  const known = new Set(SECTION_ORDER.map((s) => s.groupTitle));
  for (const g of groups) {
    if (known.has(g.title)) continue;
    const items = g.children
      .map((id) => byId.get(id))
      .filter((d): d is Declaration => !!d && ownIds.has(d.id));
    if (items.length === 0) continue;
    lines.push(`## ${g.title}`);
    lines.push("");
    for (const item of items) {
      lines.push(`- \`${item.name}\` — _${kindLabel(item.kind)}_`);
    }
    lines.push("");
  }

  lines.push("");
  lines.push("</div>");
  return lines.join("\n").trimEnd() + "\n";
}
