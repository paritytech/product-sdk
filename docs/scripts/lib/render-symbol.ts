import { kebab } from "./kebab.js";
import {
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

function mdEscape(s: string): string {
  return s.replace(/([<>{}|])/g, "\\$1");
}

function h(level: number, text: string): string {
  return `${"#".repeat(Math.min(level, 6))} ${text}`;
}

// MDX treats `{#id}` as a JSX expression (parse error). To get a stable anchor
// target on a heading, emit a self-closing <a> tag with `id` on the line above
// the heading. Nextra's auto-generated slug still appears on the heading itself,
// so both the stable anchor and the content-derived slug work.
function hWithId(level: number, text: string, id: string): string {
  return `<a id="${id}"></a>\n\n${h(level, text)}`;
}

function codeBlock(code: string, lang = "ts"): string {
  return `\`\`\`${lang}\n${code.trim()}\n\`\`\``;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Render only parameters that carry a description — types and names are already
// visible in the signature line above. Returns an empty string when none qualify,
// signalling the caller to skip the whole "Parameters" section.
function renderParamsList(parameters: Parameter[]): string {
  const items = parameters
    .map((p) => ({ name: p.name, desc: collapseWhitespace(renderSummary(p.comment)) }))
    .filter((p) => p.desc);
  if (items.length === 0) return "";
  return items.map((p) => `- \`${p.name}\`: ${mdEscape(p.desc)}`).join("\n");
}

interface SignatureOpts {
  subLevel: number;
  includeSummary: boolean;
  hideReturns?: boolean;
}

function renderSignatureDetails(
  sig: Signature,
  displayName: string,
  opts: SignatureOpts,
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

  const paramsList = renderParamsList(sig.parameters ?? []);
  if (paramsList) {
    out.push("");
    out.push(h(opts.subLevel, "Parameters"));
    out.push("");
    out.push(paramsList);
  }

  if (!opts.hideReturns) {
    const returns = (sig.comment?.blockTags ?? []).find((t) => t.tag === "@returns");
    const retDesc = returns ? renderCommentText(returns.content).trim() : "";
    if (retDesc) {
      out.push("");
      out.push(h(opts.subLevel, "Returns"));
      out.push("");
      out.push(retDesc);
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

function renderFunctionSection(d: Declaration, baseLevel: number): string {
  const out: string[] = [];
  const slug = kebab(d.name);
  const firstComment = d.signatures?.[0]?.comment;
  out.push(hWithId(baseLevel, `\`${d.name}()\``, slug));
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
      out.push(h(baseLevel + 1, `Overload ${i + 1}`));
      out.push("");
      out.push(
        renderSignatureDetails(sig, d.name, { subLevel: baseLevel + 2, includeSummary: true }),
      );
    });
  } else if (signatures.length === 1) {
    out.push(
      renderSignatureDetails(signatures[0]!, d.name, {
        subLevel: baseLevel + 1,
        includeSummary: false,
      }),
    );
  }

  return out.join("\n").trimEnd();
}

function renderMember(d: Declaration, ownerName: string, baseLevel: number): string {
  const label = kindLabel(d.kind);
  const out: string[] = [];

  // Properties / accessors collapse to a single-line signature: the name is the
  // heading, and the type sits inline on the same visual row via a data-type
  // span. Avoids the heavy "heading → code block → prose" tower for what is
  // conceptually one field definition.
  if (d.kind === Kind.Property || d.kind === Kind.Accessor) {
    const rawType =
      d.kind === Kind.Accessor
        ? typeToString(d.getSignature?.type ?? d.type)
        : typeToString(d.type);
    const type = collapseWhitespace(rawType);
    out.push(hWithId(baseLevel, `\`${d.name}\``, `${kebab(ownerName)}-${kebab(d.name)}`));
    out.push("");
    const flagTags: string[] = [];
    if (d.flags?.isReadonly) flagTags.push(`<span data-api-flag>readonly</span>`);
    if (d.flags?.isOptional) flagTags.push(`<span data-api-flag>optional</span>`);
    // Render as block JSX with the type passed through a JS string expression —
    // types contain `<`, `>`, `{`, `}`, `|` which would otherwise collide with
    // MDX's JSX / expression parsing.
    out.push(
      `<div data-api-sig><span data-api-kind>${label}</span>${flagTags.join("")}<code>{${JSON.stringify(type)}}</code></div>`,
    );
    const summary = renderSummary(
      d.kind === Kind.Accessor ? (d.getSignature?.comment ?? d.comment) : d.comment,
    );
    if (summary) {
      out.push("");
      out.push(summary);
    }
    return out.join("\n");
  }

  // Methods / constructors keep the heading + code-block pattern because their
  // signatures routinely wrap to multiple lines.
  out.push(h(baseLevel, `\`${d.name}\``));
  out.push("");

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
        subLevel: baseLevel + 1,
        includeSummary: false,
        hideReturns: isCtor,
      }),
    );
  } else {
    signatures.forEach((sig, i) => {
      out.push(h(baseLevel + 1, `Overload ${i + 1}`));
      out.push("");
      out.push(
        renderSignatureDetails(sig, displayName, {
          subLevel: baseLevel + 2,
          includeSummary: true,
          hideReturns: isCtor,
        }),
      );
      out.push("");
    });
  }
  return out.join("\n");
}

function renderClassLikeSection(
  d: Declaration,
  keyword: "class" | "interface",
  baseLevel: number,
): string {
  const out: string[] = [];
  const slug = kebab(d.name);
  out.push(hWithId(baseLevel, `\`${keyword} ${d.name}\``, slug));
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
      `**Extends:** ${d.extendedTypes.map((t) => "`" + typeToString(t) + "`").join(", ")}`,
    );
    out.push("");
  }
  if (d.implementedTypes && d.implementedTypes.length > 0) {
    out.push(
      `**Implements:** ${d.implementedTypes.map((t) => "`" + typeToString(t) + "`").join(", ")}`,
    );
    out.push("");
  }

  const remarks = renderRemarks(d.comment);
  if (remarks) {
    out.push(h(baseLevel + 1, "Remarks"));
    out.push("");
    out.push(remarks);
    out.push("");
  }

  const example = renderExamples(d.comment);
  if (example) {
    out.push(h(baseLevel + 1, "Examples"));
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
    out.push(h(baseLevel + 1, title));
    out.push("");
    for (const m of members) {
      out.push(renderMember(m, d.name, baseLevel + 2));
      out.push("");
    }
  }

  return out.join("\n").trimEnd();
}

function renderTypeAliasSection(d: Declaration, baseLevel: number): string {
  const out: string[] = [];
  const slug = kebab(d.name);
  out.push(hWithId(baseLevel, `\`type ${d.name}\``, slug));
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
    out.push(h(baseLevel + 1, "Remarks"));
    out.push("");
    out.push(remarks);
  }

  const example = renderExamples(d.comment);
  if (example) {
    out.push("");
    out.push(h(baseLevel + 1, "Examples"));
    out.push("");
    out.push(example);
  }

  return out.join("\n").trimEnd();
}

function renderVariableSection(d: Declaration, baseLevel: number): string {
  const out: string[] = [];
  const slug = kebab(d.name);
  out.push(hWithId(baseLevel, `\`${d.name}\``, slug));
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
    out.push(h(baseLevel + 1, "Examples"));
    out.push("");
    out.push(example);
  }

  return out.join("\n").trimEnd();
}

function renderEnumSection(d: Declaration, baseLevel: number): string {
  const out: string[] = [];
  const slug = kebab(d.name);
  out.push(hWithId(baseLevel, `\`enum ${d.name}\``, slug));
  out.push("");
  const summary = renderSummary(d.comment);
  if (summary) {
    out.push(summary);
    out.push("");
  }

  const members = d.children ?? [];
  if (members.length > 0) {
    out.push(h(baseLevel + 1, "Members"));
    out.push("");
    out.push("| Name | Value | Description |");
    out.push("| --- | --- | --- |");
    for (const m of members) {
      const value = m.defaultValue ?? (m.type ? typeToString(m.type) : "—");
      const desc = renderSummary(m.comment) || "—";
      out.push(`| \`${m.name}\` | \`${value}\` | ${desc} |`);
    }
  }

  return out.join("\n").trimEnd();
}

// Renders a symbol as a section fragment (no frontmatter) for embedding inside a
// package overview page. `baseLevel` is the heading level of the symbol itself;
// subsections nest from there.
export function renderSymbolSection(d: Declaration, baseLevel = 3): string | null {
  switch (d.kind) {
    case Kind.Class:
      return renderClassLikeSection(d, "class", baseLevel);
    case Kind.Interface:
      return renderClassLikeSection(d, "interface", baseLevel);
    case Kind.Function:
      return renderFunctionSection(d, baseLevel);
    case Kind.TypeAlias:
      return renderTypeAliasSection(d, baseLevel);
    case Kind.Variable:
      return renderVariableSection(d, baseLevel);
    case Kind.Enum:
      return renderEnumSection(d, baseLevel);
    default:
      return null;
  }
}
