// Minimal typings for the subset of the TypeDoc 0.28 JSON we consume.
// See https://typedoc.org/api/ for the full schema.

export const Kind = {
  Project: 1,
  Module: 2,
  Enum: 8,
  EnumMember: 16,
  Variable: 32,
  Function: 64,
  Class: 128,
  Interface: 256,
  Constructor: 512,
  Property: 1024,
  Method: 2048,
  CallSignature: 4096,
  IndexSignature: 8192,
  ConstructorSignature: 16384,
  Parameter: 32768,
  TypeLiteral: 65536,
  Accessor: 262144,
  GetSignature: 524288,
  SetSignature: 1048576,
  TypeAlias: 2097152,
  Reference: 4194304,
} as const;

export type CommentText =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "inline-tag"; tag: string; text: string; target?: unknown };

export interface BlockTag {
  tag: string;
  content: CommentText[];
  name?: string;
}

export interface Comment {
  summary?: CommentText[];
  blockTags?: BlockTag[];
  modifierTags?: string[];
}

export interface Source {
  fileName: string;
  line: number;
  character: number;
  url?: string;
}

export interface Flags {
  isOptional?: boolean;
  isRest?: boolean;
  isReadonly?: boolean;
  isStatic?: boolean;
  isPrivate?: boolean;
  isProtected?: boolean;
  isPublic?: boolean;
  isAbstract?: boolean;
  isInherited?: boolean;
  isExternal?: boolean;
}

export type TypeRef =
  | { type: "intrinsic"; name: string }
  | { type: "literal"; value: unknown }
  | { type: "reference"; name: string; typeArguments?: TypeRef[]; target?: unknown }
  | { type: "array"; elementType: TypeRef }
  | { type: "union"; types: TypeRef[] }
  | { type: "intersection"; types: TypeRef[] }
  | { type: "tuple"; elements: TypeRef[] }
  | { type: "reflection"; declaration: Declaration }
  | { type: "query"; queryType: TypeRef }
  | { type: "typeOperator"; operator: string; target: TypeRef }
  | { type: "predicate"; name: string; targetType?: TypeRef }
  | { type: "conditional"; checkType: TypeRef; extendsType: TypeRef; trueType: TypeRef; falseType: TypeRef }
  | { type: "mapped"; parameter: string; parameterType: TypeRef; templateType: TypeRef }
  | { type: "rest"; elementType: TypeRef }
  | { type: "optional"; elementType: TypeRef }
  | { type: "indexedAccess"; objectType: TypeRef; indexType: TypeRef }
  | { type: "templateLiteral"; head: string; tail: [TypeRef, string][] }
  | { type: "unknown"; name?: string }
  | { type: string; [k: string]: unknown };

export interface Parameter {
  id?: number;
  name: string;
  kind: number;
  flags?: Flags;
  type?: TypeRef;
  defaultValue?: string;
  comment?: Comment;
}

export interface Signature {
  id?: number;
  name: string;
  kind: number;
  variant?: string;
  flags?: Flags;
  comment?: Comment;
  parameters?: Parameter[];
  type?: TypeRef;
  typeParameter?: TypeParameter[];
  sources?: Source[];
}

export interface TypeParameter {
  name: string;
  type?: TypeRef;
  default?: TypeRef;
}

export interface Group {
  title: string;
  children: number[];
}

export interface Declaration {
  id: number;
  name: string;
  kind: number;
  variant?: string;
  flags?: Flags;
  comment?: Comment;
  signatures?: Signature[];
  children?: Declaration[];
  groups?: Group[];
  sources?: Source[];
  type?: TypeRef;
  typeParameter?: TypeParameter[];
  extendedTypes?: TypeRef[];
  implementedTypes?: TypeRef[];
  getSignature?: Signature;
  setSignature?: Signature;
  defaultValue?: string;
  packageName?: string;
}

export interface Project extends Declaration {
  schemaVersion: string;
  packageName?: string;
}
