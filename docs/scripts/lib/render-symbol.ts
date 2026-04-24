import { kebab } from "./kebab.js";
import {
  firstLine,
  renderDeprecated,
  renderExamples,
  renderRemarks,
  renderSeeAlso,
  renderSummary,
  renderThrows,
  renderCommentText,
} from "./render-comment.js";
import {
  kindLabel,
  signatureLine,
  typeParamsToString,
  typeToString,
} from "./render-type.js";
import { Kind, type Declaration, type Parameter, type Signature } from "./types.js";

export interface SymbolPage {
  fileName: string;
  body: string;
  title: string;
}

const escapeYaml = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function frontmatter(title: string, description?: string): string {
  const lines = ["---", "generated: true", `title: "${escapeYaml(title)}"`];
  if (description) lines.push(`description: "${escapeYaml(firstLine(description))}"`);
  lines.push("---", "");
  return lines.join("\n");
}

function mdEscape(s: string): string {
  return s.replace(/([<>{}|])/g, "\\$1");
}

function codeBlock(code: string, lang = "ts"): string {
  return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function renderParamsTable(parameters: Parameter[]): string {
  if (parameters.length === 0) return "_No parameters._";
  const rows = parameters.map((p) => {
    const type = collapseWhitespace(typeToString(p.type)).replace(/\|/g, "\\|");
    const optional = p.flags?.isOptional ? " _(optional)_" : "";
    const def = p.defaultValue ? ` = \`${p.defaultValue}\`` : "";
    const desc = collapseWhitespace(renderSummary(p.comment)) || "—";
    return `| \`${p.name}\`${optional} | \`${type}\`${def} | ${mdEscape(desc)} |`;
  });
  return ["| Parameter | Type | Description |", "| --- | --- | --- |", ...rows].join("\n");
}

interface SignatureOpts {
  // Heading level for the "Parameters" / "Returns" / "Examples" subsections.
  subLevel: number;
  // Include the signature summary. Set false when the caller already printed it above.
  includeSummary: boolean;
  // Hide the Returns section (useful for constructors).
  hideReturns?: boolean;
}

function h(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

function renderSignatureDetails(
  sig: Signature,
  displayName: string,
  opts: SignatureOpts
): string {
  const out: string[] = [];
  out.push(codeBlock(signatureLine(displayName, sig)));

  if (opts.includeSummary) {
    const summary = renderSummary(sig.comment);
    if (summary) {
      out.push("");
      out.push(summary);
    }
  }

  const remarks = renderRemarks(sig.comment);
  if (remarks) {
    out.push("");
    out.push(h(opts.subLevel, "Remarks"));
    out.push("");
    out.push(remarks);
  }

  out.push("");
  out.push(h(opts.subLevel, "Parameters"));
  out.push("");
  out.push(renderParamsTable(sig.parameters ?? []));

  if (!opts.hideReturns) {
    const ret = typeToString(sig.type);
    if (ret && ret !== "void" && ret !== "undefined") {
      const returns = (sig.comment?.blockTags ?? []).find((t) => t.tag === "@returns");
      const retDesc = returns ? renderCommentText(returns.content).trim() : "";
      const body = `\`${ret}\`${retDesc ? " — " + retDesc : ""}`;
      out.push("");
      out.push(h(opts.subLevel, "Returns"));
      out.push("");
      out.push(body);
    }
  }

  const throws = renderThrows(sig.comment);
  if (throws.length > 0) {
    out.push("");
    out.push(h(opts.subLevel, "Throws"));
    out.push("");
    out.push(throws.map((t) => "- " + t).join("\n"));
  }

  const example = renderExamples(sig.comment);
  if (example) {
    out.push("");
    out.push(h(opts.subLevel, "Examples"));
    out.push("");
    out.push(example);
  }

  const sees = renderSeeAlso(sig.comment);
  if (sees.length > 0) {
    out.push("");
    out.push(h(opts.subLevel, "See also"));
    out.push("");
    out.push(sees.map((s) => "- " + s).join("\n"));
  }

  return out.join("\n");
}

function renderFunctionPage(d: Declaration): string {
  const out: string[] = [];
  const firstComment = d.signatures?.[0]?.comment;
  out.push(`# \`${d.name}()\``);
  out.push("");
  const topSummary = renderSummary(firstComment);
  if (topSummary) {
    out.push(topSummary);
    out.push("");
  }

  const deprecated = renderDeprecated(firstComment);
  if (deprecated) {
    out.push(`> **Deprecated.** ${deprecated}`);
    out.push("");
  }

  const signatures = d.signatures ?? [];
  if (signatures.length > 1) {
    out.push("This function has multiple overloads.");
    signatures.forEach((sig, i) => {
      out.push("");
      out.push(`## Overload ${i + 1}`);
      out.push("");
      out.push(renderSignatureDetails(sig, d.name, { subLevel: 3, includeSummary: true }));
    });
  } else if (signatures.length === 1) {
    out.push(
      renderSignatureDetails(signatures[0]!, d.name, {
        subLevel: 2,
        includeSummary: false,
      })
    );
  }

  return out.join("\n").trimEnd() + "\n";
}

function renderMember(d: Declaration, ownerName: string): string {
  const label = kindLabel(d.kind);
  const anchor = `\`${d.name}\``;
  const out: string[] = [`### ${label} ${anchor}`, ""];

  if (d.kind === Kind.Property) {
    const type = typeToString(d.type);
    out.push(codeBlock(`${d.name}: ${type}`));
    const summary = renderSummary(d.comment);
    if (summary) {
      out.push("");
      out.push(summary);
    }
    return out.join("\n");
  }

  if (d.kind === Kind.Accessor) {
    const type = typeToString(d.getSignature?.type ?? d.type);
    out.push(codeBlock(`${d.name}: ${type}`));
    const summary = renderSummary(d.getSignature?.comment ?? d.comment);
    if (summary) {
      out.push("");
      out.push(summary);
    }
    return out.join("\n");
  }

  const signatures = d.signatures ?? [];
  const isCtor = d.kind === Kind.Constructor;
  const displayName = isCtor ? `new ${ownerName}` : d.name;
  if (signatures.length === 0) {
    out.push("_No signature._");
    return out.join("\n");
  }
  const topSummary = renderSummary(signatures[0]!.comment);
  if (topSummary) {
    out.push(topSummary);
    out.push("");
  }
  if (signatures.length === 1) {
    out.push(
      renderSignatureDetails(signatures[0]!, displayName, {
        subLevel: 4,
        includeSummary: false,
        hideReturns: isCtor,
      })
    );
  } else {
    signatures.forEach((sig, i) => {
      out.push(`#### Overload ${i + 1}`);
      out.push("");
      out.push(
        renderSignatureDetails(sig, displayName, {
          subLevel: 5,
          includeSummary: true,
          hideReturns: isCtor,
        })
      );
      out.push("");
    });
  }
  return out.join("\n");
}

function renderClassLikePage(d: Declaration, keyword: "class" | "interface"): string {
  const out: string[] = [];
  out.push(`# \`${keyword} ${d.name}\``);
  out.push("");
  const summary = renderSummary(d.comment);
  if (summary) {
    out.push(summary);
    out.push("");
  }

  const deprecated = renderDeprecated(d.comment);
  if (deprecated) {
    out.push(`> **Deprecated.** ${deprecated}`);
    out.push("");
  }

  if (d.extendedTypes && d.extendedTypes.length > 0) {
    out.push(
      `**Extends:** ${d.extendedTypes.map((t) => "`" + typeToString(t) + "`").join(", ")}`
    );
    out.push("");
  }
  if (d.implementedTypes && d.implementedTypes.length > 0) {
    out.push(
      `**Implements:** ${d.implementedTypes.map((t) => "`" + typeToString(t) + "`").join(", ")}`
    );
    out.push("");
  }

  const remarks = renderRemarks(d.comment);
  if (remarks) {
    out.push("## Remarks");
    out.push("");
    out.push(remarks);
    out.push("");
  }

  const example = renderExamples(d.comment);
  if (example) {
    out.push("## Examples");
    out.push("");
    out.push(example);
    out.push("");
  }

  const byId = new Map<number, Declaration>();
  (d.children ?? []).forEach((c) => byId.set(c.id, c));
  const groups = d.groups ?? [];

  const sectionOrder = ["Constructors", "Properties", "Accessors", "Methods"];
  for (const title of sectionOrder) {
    const g = groups.find((x) => x.title === title);
    if (!g) continue;
    const members = g.children
      .map((id) => byId.get(id))
      .filter((m): m is Declaration => !!m)
      .filter((m) => !m.flags?.isInherited && !m.flags?.isPrivate);
    if (members.length === 0) continue;
    out.push(`## ${title}`);
    out.push("");
    for (const m of members) {
      out.push(renderMember(m, d.name));
      out.push("");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}

function renderTypeAliasPage(d: Declaration): string {
  const out: string[] = [];
  out.push(`# \`type ${d.name}\``);
  out.push("");
  const summary = renderSummary(d.comment);
  if (summary) {
    out.push(summary);
    out.push("");
  }

  const deprecated = renderDeprecated(d.comment);
  if (deprecated) {
    out.push(`> **Deprecated.** ${deprecated}`);
    out.push("");
  }

  const tps = typeParamsToString(d.typeParameter);
  out.push(codeBlock(`type ${d.name}${tps} = ${typeToString(d.type)}`));

  const remarks = renderRemarks(d.comment);
  if (remarks) {
    out.push("");
    out.push("## Remarks");
    out.push("");
    out.push(remarks);
  }

  const example = renderExamples(d.comment);
  if (example) {
    out.push("");
    out.push("## Examples");
    out.push("");
    out.push(example);
  }

  return out.join("\n").trimEnd() + "\n";
}

function renderVariablePage(d: Declaration): string {
  const out: string[] = [];
  out.push(`# \`${d.name}\``);
  out.push("");
  const summary = renderSummary(d.comment);
  if (summary) {
    out.push(summary);
    out.push("");
  }

  const declKeyword = d.flags?.isReadonly ? "const" : "let";
  const def = d.defaultValue ? ` = ${d.defaultValue}` : "";
  out.push(codeBlock(`${declKeyword} ${d.name}: ${typeToString(d.type)}${def}`));

  const example = renderExamples(d.comment);
  if (example) {
    out.push("");
    out.push("## Examples");
    out.push("");
    out.push(example);
  }

  return out.join("\n").trimEnd() + "\n";
}

function renderEnumPage(d: Declaration): string {
  const out: string[] = [];
  out.push(`# \`enum ${d.name}\``);
  out.push("");
  const summary = renderSummary(d.comment);
  if (summary) {
    out.push(summary);
    out.push("");
  }

  const members = d.children ?? [];
  if (members.length > 0) {
    out.push("## Members");
    out.push("");
    out.push("| Name | Value | Description |");
    out.push("| --- | --- | --- |");
    for (const m of members) {
      const value = m.defaultValue ?? (m.type ? typeToString(m.type) : "—");
      const desc = renderSummary(m.comment) || "—";
      out.push(`| \`${m.name}\` | \`${value}\` | ${desc} |`);
    }
  }

  return out.join("\n").trimEnd() + "\n";
}

export function pageFor(d: Declaration): SymbolPage | null {
  const slug = kebab(d.name);
  const summary = firstLine(
    renderSummary(d.comment) || renderSummary(d.signatures?.[0]?.comment)
  );
  let body: string;
  let title: string;
  switch (d.kind) {
    case Kind.Class:
      body = renderClassLikePage(d, "class");
      title = `class ${d.name}`;
      break;
    case Kind.Interface:
      body = renderClassLikePage(d, "interface");
      title = `interface ${d.name}`;
      break;
    case Kind.Function:
      body = renderFunctionPage(d);
      title = `${d.name}()`;
      break;
    case Kind.TypeAlias:
      body = renderTypeAliasPage(d);
      title = `type ${d.name}`;
      break;
    case Kind.Variable:
      body = renderVariablePage(d);
      title = d.name;
      break;
    case Kind.Enum:
      body = renderEnumPage(d);
      title = `enum ${d.name}`;
      break;
    default:
      return null;
  }
  return {
    fileName: `${slug}.mdx`,
    body: frontmatter(title, summary) + body,
    title,
  };
}
