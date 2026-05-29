// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { packageSlug } from "./kebab.js";
import type { PackageRegistry } from "./registry.js";
import type { Declaration } from "./types.js";

// TypeDoc emits `sources[].fileName` paths whose prefix depends on the working
// directory it resolved the package from. We've seen all of the following in one
// JSON from the same run:
//   - "packages/address/src/ss58.ts"         (leaf, relative to monorepo root)
//   - "product-sdk/packages/bulletin/src/..." (leaf, relative to repo root)
//   - "sdk/src/core/types.ts"                (umbrella, sibling packages root)
//   - "bulletin/dist/index.d.ts"             (umbrella, leaf consumed via dist)
//   - "node_modules/.pnpm/.../dist/..."      (external re-export)
// So we can't trust the first path segment — instead we look for any segment
// that matches a folder discovered from the workspace registry, falling back
// to "external" when no internal match is found.

export function firstSourceFile(d: Declaration): string {
  return d.sources?.[0]?.fileName ?? "";
}

function isFromNodeModules(src: string): boolean {
  return src.includes("node_modules/");
}

// Find which internal SDK package folder (if any) a declaration originates from.
// Returns null for external / node_modules sources.
export function originPackageFolder(
  d: Declaration,
  registry: PackageRegistry,
): string | null {
  const src = firstSourceFile(d);
  if (!src || isFromNodeModules(src)) return null;

  // Match any segment that is a known workspace package folder and is followed
  // by /src/ or /dist/. Covers "packages/<f>/src/", "<f>/dist/",
  // "product-sdk/packages/<f>/src/".
  const matches = src.matchAll(/(?:^|\/)([^/]+)\/(?:src|dist)\//g);
  for (const m of matches) {
    const folder = m[1]!;
    if (registry.folders.has(folder)) return folder;
  }
  return null;
}

// A symbol is an "own export" of `ownFolder` if either:
//   - its source is inside that folder (packages/<ownFolder>/src or dist), OR
//   - we can't attribute it to any internal SDK package (external re-export, e.g.
//     types re-exported from @polkadot-api/substrate-bindings). External re-exports
//     should still get a standalone page under the leaf that re-exports them, since
//     there's no internal doc page to link to.
export function isOwnExport(
  d: Declaration,
  ownFolder: string,
  registry: PackageRegistry,
): boolean {
  const origin = originPackageFolder(d, registry);
  if (origin === null) return true;
  return origin === ownFolder;
}

export function isReExport(
  d: Declaration,
  ownFolder: string,
  registry: PackageRegistry,
): boolean {
  return !isOwnExport(d, ownFolder, registry);
}

// Map a package folder name to its URL slug.
//
// The slug comes from the package's `name` field (kebab-cased after stripping
// the `@parity/product-sdk-` prefix), NOT the folder. This decouples filesystem
// layout from URL paths so a package can rename its `name` without renaming
// the directory (or vice-versa) and still get correct cross-package links.
export function packageFolderToSlug(
  folder: string,
  registry: PackageRegistry,
): string | null {
  const name = registry.folderToName.get(folder);
  return name ? packageSlug(name) : null;
}
