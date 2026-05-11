#!/usr/bin/env bash
# Build per-chain descriptors. Each chain has its own papi config and
# generates into its own chains/<name>/generated/dist/ directory.
# This avoids bundling all chains into one index.mjs.
set -euo pipefail

cd "$(dirname "$0")/.."

CHAINS="polkadot-asset-hub kusama-asset-hub paseo-asset-hub previewnet-asset-hub paseo-bulletin previewnet-bulletin paseo-individuality previewnet-individuality"

for chain in $CHAINS; do
    dir="chains/$chain"

    # Skip if already built
    if [ -f "$dir/generated/dist/index.js" ]; then
        echo "  Skipping $chain (already built)"
        continue
    fi

    echo "  Building $chain..."
    (
        cd "$dir"
        npx papi generate --config .papi/polkadot-api.json

        # papi adds "dependencies": { "@polkadot-api/descriptors": "file:generated" }
        # to the chain's package.json — strip it so it doesn't interfere.
        node --input-type=commonjs -e '
            const p = require("./package.json");
            delete p.dependencies;
            require("fs").writeFileSync("package.json", JSON.stringify(p, null, 4) + "\n");
        '
    )
done

echo "✓ All descriptors built successfully"
