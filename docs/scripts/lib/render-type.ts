import type { Declaration, Parameter, TypeParameter, TypeRef } from "./types.js";
import { Kind } from "./types.js";

// Stringify a TypeDoc type reflection to TypeScript-like source.
// Not a full type printer; covers the shapes that appear in the SDK.
export function typeToString(t: TypeRef | undefined): string {
  if (!t) return "unknown";
  switch (t.type) {
    case "intrinsic":
      return (t as { name: string }).name;
    case "literal": {
      const v = (t as { value: unknown }).value;
      if (v === null) return "null";
      if (typeof v === "string") return JSON.stringify(v);
      if (typeof v === "object" && v !== null && "value" in v) {
        // bigint literal: { value: string, negative: boolean }
        const b = v as { value: string; negative?: boolean };
        return `${b.negative ? "-" : ""}${b.value}n`;
      }
      return String(v);
    }
    case "reference": {
      const r = t as { name: string; typeArguments?: TypeRef[] };
      const args = r.typeArguments && r.typeArguments.length > 0
        ? `<${r.typeArguments.map(typeToString).join(", ")}>`
        : "";
      return `${r.name}${args}`;
    }
    case "array":
      return `${typeToString((t as { elementType: TypeRef }).elementType)}[]`;
    case "union":
      return (t as { types: TypeRef[] }).types.map(typeToString).join(" | ");
    case "intersection":
      return (t as { types: TypeRef[] }).types.map(typeToString).join(" & ");
    case "tuple": {
      const elements = (t as { elements?: TypeRef[] }).elements ?? [];
      return `[${elements.map(typeToString).join(", ")}]`;
    }
    case "reflection": {
      const d = (t as { declaration: Declaration }).declaration;
      return reflectionToString(d);
    }
    case "query":
      return `typeof ${typeToString((t as { queryType: TypeRef }).queryType)}`;
    case "typeOperator": {
      const op = t as { operator: string; target: TypeRef };
      return `${op.operator} ${typeToString(op.target)}`;
    }
    case "predicate": {
      const p = t as { name: string; targetType?: TypeRef };
      const target = p.targetType ? ` is ${typeToString(p.targetType)}` : "";
      return `${p.name}${target}`;
    }
    case "conditional": {
      const c = t as {
        checkType: TypeRef;
        extendsType: TypeRef;
        trueType: TypeRef;
        falseType: TypeRef;
      };
      return `${typeToString(c.checkType)} extends ${typeToString(c.extendsType)} ? ${typeToString(c.trueType)} : ${typeToString(c.falseType)}`;
    }
    case "mapped": {
      const m = t as {
        parameter: string;
        parameterType: TypeRef;
        templateType: TypeRef;
      };
      return `{ [${m.parameter} in ${typeToString(m.parameterType)}]: ${typeToString(m.templateType)} }`;
    }
    case "rest":
      return `...${typeToString((t as { elementType: TypeRef }).elementType)}`;
    case "optional":
      return `${typeToString((t as { elementType: TypeRef }).elementType)}?`;
    case "indexedAccess": {
      const ix = t as { objectType: TypeRef; indexType: TypeRef };
      return `${typeToString(ix.objectType)}[${typeToString(ix.indexType)}]`;
    }
    case "templateLiteral": {
      const tl = t as { head: string; tail: [TypeRef, string][] };
      const parts = tl.tail.map(([ref, lit]) => `\${${typeToString(ref)}}${lit}`).join("");
      return `\`${tl.head}${parts}\``;
    }
    case "unknown":
      return (t as { name?: string }).name ?? "unknown";
    default:
      return "unknown";
  }
}

function reflectionToString(d: Declaration): string {
  // Function type: { (...): ... }
  if (d.signatures && d.signatures.length > 0) {
    const sig = d.signatures[0]!;
    const tp = typeParamsToString(sig.typeParameter);
    const params = (sig.parameters ?? []).map(paramToString).join(", ");
    const ret = typeToString(sig.type);
    return `${tp}(${params}) => ${ret}`;
  }
  // Object type literal
  if (d.children && d.children.length > 0) {
    const fields = d.children
      .map((c) => {
        const optional = c.flags?.isOptional ? "?" : "";
        const readonly = c.flags?.isReadonly ? "readonly " : "";
        return `${readonly}${c.name}${optional}: ${typeToString(c.type)}`;
      })
      .join("; ");
    return `{ ${fields} }`;
  }
  return "object";
}

export function paramToString(p: Parameter): string {
  const rest = p.flags?.isRest ? "..." : "";
  const optional = p.flags?.isOptional ? "?" : "";
  const def = p.defaultValue ? ` = ${p.defaultValue}` : "";
  return `${rest}${p.name}${optional}: ${typeToString(p.type)}${def}`;
}

export function typeParamsToString(tps: TypeParameter[] | undefined): string {
  if (!tps || tps.length === 0) return "";
  const parts = tps.map((tp) => {
    const constraint = tp.type ? ` extends ${typeToString(tp.type)}` : "";
    const def = tp.default ? ` = ${typeToString(tp.default)}` : "";
    return `${tp.name}${constraint}${def}`;
  });
  return `<${parts.join(", ")}>`;
}

export function signatureLine(fnName: string, sig: import("./types.js").Signature): string {
  const tp = typeParamsToString(sig.typeParameter);
  const params = (sig.parameters ?? []).map(paramToString).join(", ");
  const ret = typeToString(sig.type);
  return `${fnName}${tp}(${params}): ${ret}`;
}

export function kindLabel(kind: number): string {
  switch (kind) {
    case Kind.Class:
      return "class";
    case Kind.Interface:
      return "interface";
    case Kind.Function:
      return "function";
    case Kind.TypeAlias:
      return "type";
    case Kind.Variable:
      return "variable";
    case Kind.Enum:
      return "enum";
    case Kind.Method:
      return "method";
    case Kind.Property:
      return "property";
    case Kind.Accessor:
      return "accessor";
    case Kind.Constructor:
      return "constructor";
    default:
      return "export";
  }
}
