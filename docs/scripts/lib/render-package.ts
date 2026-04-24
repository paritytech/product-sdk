import { kebab, packageSlug } from "./kebab.js";
import {
  isOwnExport,
  originPackageFolder,
  packageFolderToSlug,
} from "./reexports.js";
import { firstLine, renderSummary } from "./render-comment.js";
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

const escapeYaml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export function sanitizePackageSummary(summary: string, pkgName: string): string {
  const lines = summary.split(/\r?\n/);
  // Drop empty leading lines and any leading line that is just the package name.
  while (lines.length > 0) {
    const first = lines[0]!.trim();
    if (first === pkgName || first === "") {
      lines.shift();
    } else {
      break;
    }
  }
  // If the first remaining line starts with "<pkgName> — " / ": " / "- ", strip the prefix.
  if (lines.length > 0) {
    const escaped = pkgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefixPattern = new RegExp(`^${escaped}\\s*[—:\\-]\\s*`);
    lines[0] = lines[0]!.replace(prefixPattern, "");
  }
  return lines.join("\n").trim();
}

function itemSummary(item: Declaration): string {
  const raw = firstLine(
    renderSummary(item.comment) || renderSummary(item.signatures?.[0]?.comment)
  );
  return raw ? raw.replace(/\s+/g, " ").replace(/\|/g, "\\|") : "";
}

function labelFor(item: Declaration): string {
  return item.kind === Kind.Function ? `${item.name}()` : item.name;
}

export function renderPackageOverview(pkg: Declaration, ownFolder: string): string {
  const slug = packageSlug(pkg.name);
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

  const byId = new Map<number, Declaration>();
  (pkg.children ?? []).forEach((c) => byId.set(c.id, c));
  const groups = pkg.groups ?? [];

  const ownChildren: Declaration[] = [];
  const reExportChildren: Declaration[] = [];
  for (const child of pkg.children ?? []) {
    if (isOwnExport(child, ownFolder)) ownChildren.push(child);
    else reExportChildren.push(child);
  }
  const ownIds = new Set(ownChildren.map((c) => c.id));

  for (const section of SECTION_ORDER) {
    const group = groups.find((g) => g.title === section.groupTitle);
    if (!group) continue;
    const items = group.children
      .map((id) => byId.get(id))
      .filter((d): d is Declaration => !!d && d.kind === section.kind && ownIds.has(d.id));
    if (items.length === 0) continue;

    lines.push(`## ${section.title}`);
    lines.push("");
    lines.push("| Name | Summary |");
    lines.push("| --- | --- |");
    for (const item of items) {
      const href = `/api/${slug}/${kebab(item.name)}`;
      const summary = itemSummary(item) || "—";
      lines.push(`| [\`${labelFor(item)}\`](${href}) | ${summary} |`);
    }
    lines.push("");
  }

  if (reExportChildren.length > 0) {
    lines.push("## Re-exports");
    lines.push("");
    lines.push(
      `Convenience re-exports from leaf packages. Click through for the canonical documentation.`
    );
    lines.push("");
    lines.push("| Name | Kind | Source package |");
    lines.push("| --- | --- | --- |");
    // Sort re-exports alphabetically for stable output.
    reExportChildren
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((item) => {
        const folder = originPackageFolder(item);
        const leafSlug = folder ? packageFolderToSlug(folder) : null;
        const href = leafSlug ? `/api/${leafSlug}/${kebab(item.name)}` : null;
        const nameCell = href ? `[\`${labelFor(item)}\`](${href})` : `\`${labelFor(item)}\``;
        const kindCell = kindLabel(item.kind);
        const leafPackage = folder
          ? `[\`@parity/product-sdk-${folder}\`](/api/${leafSlug})`
          : "—";
        lines.push(`| ${nameCell} | ${kindCell} | ${leafPackage} |`);
      });
    lines.push("");
  }

  // Leftover groups (e.g. "References") that aren't in our section order.
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

  return lines.join("\n").trimEnd() + "\n";
}
