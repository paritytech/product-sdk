// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

export function packageSlug(packageName: string): string {
  if (packageName === "@parity/product-sdk") return "sdk";
  // Strip the `@parity/product-sdk-` prefix for SDK packages, or a bare
  // `@parity/` scope for neutrally-named shared packages (e.g. `@parity/result`).
  // The slug must be a plain path segment — a leftover `/` breaks Nextra's `_meta`.
  return packageName.replace(/^@parity\/(product-sdk-)?/, "");
}
