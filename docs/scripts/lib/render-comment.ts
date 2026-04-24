import type { BlockTag, Comment, CommentText } from "./types.js";

// Escape MDX-hostile characters in free prose: curly braces parse as JSX expressions,
// and stray `<` can start a JSX tag. `code` parts (triple-backtick blocks) pass through
// unchanged because MDX leaves code fences alone.
function escapeFreeText(s: string): string {
  return s.replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/<(?=[A-Za-z!?/])/g, "\\<");
}

export function renderCommentText(parts: CommentText[] | undefined): string {
  if (!parts) return "";
  return parts
    .map((p) => {
      if (p.kind === "code") return p.text;
      if (p.kind === "inline-tag") {
        if (p.tag === "@link" || p.tag === "@linkcode" || p.tag === "@linkplain") {
          return `\`${p.text}\``;
        }
        return escapeFreeText(p.text);
      }
      return escapeFreeText(p.text);
    })
    .join("");
}

export function renderSummary(comment: Comment | undefined): string {
  return renderCommentText(comment?.summary).trim();
}

export function firstLine(text: string): string {
  const [first] = text.split(/\r?\n/);
  return (first ?? "").trim();
}

export function blockTagsByName(comment: Comment | undefined, tag: string): BlockTag[] {
  return (comment?.blockTags ?? []).filter((t) => t.tag === tag);
}

export function renderExamples(comment: Comment | undefined): string {
  const examples = blockTagsByName(comment, "@example");
  if (examples.length === 0) return "";
  const blocks = examples.map((ex) => renderCommentText(ex.content).trim());
  return blocks.join("\n\n");
}

export function renderSeeAlso(comment: Comment | undefined): string[] {
  return blockTagsByName(comment, "@see").map((t) => renderCommentText(t.content).trim());
}

export function renderThrows(comment: Comment | undefined): string[] {
  return blockTagsByName(comment, "@throws").map((t) => renderCommentText(t.content).trim());
}

export function renderRemarks(comment: Comment | undefined): string {
  const remarks = blockTagsByName(comment, "@remarks");
  if (remarks.length === 0) return "";
  return remarks.map((t) => renderCommentText(t.content).trim()).join("\n\n");
}

export function renderDeprecated(comment: Comment | undefined): string | null {
  const dep = blockTagsByName(comment, "@deprecated");
  if (dep.length === 0) return null;
  return dep.map((t) => renderCommentText(t.content).trim()).join(" ") || "Deprecated.";
}
