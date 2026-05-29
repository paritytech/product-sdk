// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read the umbrella package's version at module load (server-side). This keeps
// the navbar badge in sync with releases without manual updates.
const sdkPkg = JSON.parse(
  readFileSync(
    join(process.cwd(), "../product-sdk/packages/sdk/package.json"),
    "utf8",
  ),
) as { version: string };

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function Logo() {
  return (
    <div className="flex items-center h-8">
      <img
        src={`${basePath}/logo-symbol-wordmark_dark.svg`}
        alt="Polkadot"
        className="block dark:hidden h-7 w-auto"
      />
      <img
        src={`${basePath}/logo-symbol-wordmark_light.svg`}
        alt="Polkadot"
        className="hidden dark:block h-7 w-auto"
      />
      <span className="ml-3 font-semibold text-sm text-secondary">
        Product SDK
      </span>
      <span className="ml-2 font-mono text-xs text-secondary/70 border border-secondary/20 rounded px-1.5 py-0.5">
        v{sdkPkg.version}
      </span>
    </div>
  );
}
