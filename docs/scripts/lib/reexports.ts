import { packageSlug } from "./kebab.js";
import type { Declaration } from "./types.js";

// TypeDoc emits `sources[].fileName` paths whose prefix depends on the working
// directory it resolved the package from. We've seen all of the following in one
// JSON from the same run:
//   - "packages/address/src/ss58.ts"         (leaf, relative to monorepo root)
//   - "product-sdk/packages/bulletin/src/..." (leaf, relative to repo root)
//   - "sdk/src/core/types.ts"                (umbrella, sibling packages root)
//   - "bulletin/dist/index.d.ts"             (umbrella, leaf consumed via dist)
//   - "node_modules/.pnpm/.../dist/..."      (external re-export)
// So we can't trust the first path segment — instead we look for a known SDK
// package folder anywhere in the path, and fall back to treating the symbol as
// own-package when no internal match is found.

// These are the folders under product-sdk/packages/ we generate docs for.
const INTERNAL_PACKAGE_FOLDERS = new Set([
  "address",
  "bulletin",
  "chain-client",
  "contracts",
  "crypto",
  "host",
  "keys",
  "logger",
  "sdk",
  "signer",
  "statement-store",
  "storage",
  "tx",
  "utils",
]);

export function firstSourceFile(d: Declaration): string {
  return d.sources?.[0]?.fileName ?? "";
}

function isFromNodeModules(src: string): boolean {
  return src.includes("node_modules/");
}

// Find which internal SDK package folder (if any) a declaration originates from.
// Returns null for external / node_modules sources.
export function originPackageFolder(d: Declaration): string | null {
  const src = firstSourceFile(d);
  if (!src || isFromNodeModules(src)) return null;

  // Match any segment that is a known internal package folder and is followed by
  // /src/ or /dist/. Covers "packages/<f>/src/", "<f>/dist/", "product-sdk/packages/<f>/src/".
  const matches = src.matchAll(/(?:^|\/)([^/]+)\/(?:src|dist)\//g);
  for (const m of matches) {
    const folder = m[1]!;
    if (INTERNAL_PACKAGE_FOLDERS.has(folder)) return folder;
  }
  return null;
}

// A symbol is an "own export" of `ownFolder` if either:
//   - its source is inside that folder (packages/<ownFolder>/src or dist), OR
//   - we can't attribute it to any internal SDK package (external re-export, e.g.
//     types re-exported from @polkadot-api/substrate-bindings). External re-exports
//     should still get a standalone page under the leaf that re-exports them, since
//     there's no internal doc page to link to.
export function isOwnExport(d: Declaration, ownFolder: string): boolean {
  const origin = originPackageFolder(d);
  if (origin === null) return true;
  return origin === ownFolder;
}

export function isReExport(d: Declaration, ownFolder: string): boolean {
  return !isOwnExport(d, ownFolder);
}

// Map package folder name (e.g. "signer") to the slug used for doc URLs.
export function packageFolderToSlug(folder: string): string {
  return packageSlug(`@parity/product-sdk-${folder}`);
}
