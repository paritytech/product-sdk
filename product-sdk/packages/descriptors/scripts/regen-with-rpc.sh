#!/usr/bin/env bash
# Regenerate one or more descriptors against a user-supplied RPC.
#
# When the bundled default RPC is rate-limited / down / blocking your country,
# this rewrites a chain's `.papi/polkadot-api.json` to point at the RPC you
# provide, runs `papi update` to fetch fresh metadata and codeHash, then
# regenerates the TypeScript bindings.
#
# USAGE
#   ./scripts/regen-with-rpc.sh --chain <name> --rpc <wss-url> [--chain ...]
#
#   --chain   chain directory under chains/ (e.g. paseo-asset-hub).
#             Repeatable: pair each --chain with its own --rpc.
#   --rpc     WebSocket endpoint for that chain.
#   --keep    don't restore the previous polkadot-api.json on exit (off by default).
#   --list    print available chains and exit.
#
# Run from product-sdk/packages/descriptors:
#   ./scripts/regen-with-rpc.sh \
#     --chain paseo-asset-hub --rpc wss://my.rpc.example/paseo-ah
#
# IMPORTANT: a mismatched RPC (e.g. one pointing at a forked chain) will
# rewrite the genesis hash. The script warns when genesis drifts so you
# notice — but the changed files are real, so commit them deliberately
# or rely on the default restore behaviour to revert them on success.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHAINS_DIR="$PKG_ROOT/chains"

# Parallel arrays — bash doesn't have native dicts that survive subshells well,
# and we want chain ↔ rpc pairing preserved in invocation order.
CHAINS=()
RPCS=()
KEEP=false
LIST=false

usage() {
    cat <<'EOF'
Usage: ./scripts/regen-with-rpc.sh --chain <name> --rpc <wss-url> [--chain <name> --rpc <wss-url> ...]
       ./scripts/regen-with-rpc.sh --list

Options:
  --chain <name>   chain directory under chains/ (e.g. paseo-asset-hub).
                   Repeatable: pair each --chain with its own --rpc.
  --rpc <url>      WebSocket endpoint for that chain.
  --keep           don't restore polkadot-api.json on exit (off by default).
  --list           print available chains and exit.
EOF
}

list_chains() {
    for d in "$CHAINS_DIR"/*/; do
        [ -d "$d" ] || continue
        basename "$d"
    done
}

# Parse args. Enforces strict --chain/--rpc pairing so users get a clear error
# rather than a half-applied override.
pending_chain=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --list)
            LIST=true
            shift
            ;;
        --keep)
            KEEP=true
            shift
            ;;
        --chain)
            [[ -n "$pending_chain" ]] && { echo "Error: --chain given without a paired --rpc" >&2; exit 1; }
            pending_chain="${2:?--chain requires a value}"
            shift 2
            ;;
        --rpc)
            [[ -z "$pending_chain" ]] && { echo "Error: --rpc given before --chain" >&2; exit 1; }
            CHAINS+=("$pending_chain")
            RPCS+=("${2:?--rpc requires a value}")
            pending_chain=""
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Error: unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done
[[ -n "$pending_chain" ]] && { echo "Error: --chain given without a paired --rpc" >&2; exit 1; }

if $LIST; then
    echo "Available chains:"
    while IFS= read -r c; do echo "  - $c"; done < <(list_chains)
    exit 0
fi

if [[ ${#CHAINS[@]} -eq 0 ]]; then
    usage >&2
    exit 1
fi

# Validate chain names up front so we fail before mutating anything.
available=$(list_chains | tr '\n' ' ')
for chain in "${CHAINS[@]}"; do
    if ! echo " $available " | grep -q " $chain "; then
        echo "Error: unknown chain \"$chain\". Available: $available" >&2
        exit 1
    fi
done

# Snapshot each config to a backup so we can restore on any failure or on
# clean exit (unless --keep). Stored alongside the original; cleaned up by
# the trap below.
BACKUPS=()
for chain in "${CHAINS[@]}"; do
    cfg="$CHAINS_DIR/$chain/.papi/polkadot-api.json"
    backup="$cfg.bak.$$"
    cp "$cfg" "$backup"
    BACKUPS+=("$cfg|$backup")
done

# Restore on any exit unless --keep, then remove backup files either way.
restore_configs() {
    if ! $KEEP; then
        for pair in "${BACKUPS[@]}"; do
            cfg="${pair%|*}"
            backup="${pair#*|}"
            [[ -f "$backup" ]] && cp "$backup" "$cfg"
        done
    fi
    for pair in "${BACKUPS[@]}"; do
        backup="${pair#*|}"
        rm -f "$backup"
    done
}
trap restore_configs EXIT INT TERM

# Patch a single config: drop the well-known `chain:` field if present and set
# `wsUrl:` to the supplied endpoint. Either form is valid for papi; only
# `wsUrl` triggers a real network fetch on `papi update`.
patch_config_with_rpc() {
    local cfg="$1" rpc="$2"
    # Single-entry assumption matches every config under chains/*/.
    node --input-type=module -e "
        import { readFileSync, writeFileSync } from 'node:fs';
        const cfg = JSON.parse(readFileSync('$cfg', 'utf8'));
        const keys = Object.keys(cfg.entries);
        if (keys.length !== 1) {
            console.error('Expected exactly one entry, found ' + keys.length);
            process.exit(1);
        }
        const entry = cfg.entries[keys[0]];
        delete entry.chain;
        entry.wsUrl = '$rpc';
        writeFileSync('$cfg', JSON.stringify(cfg, null, 4) + '\n');
        console.log(keys[0]);
    "
}

read_genesis() {
    local cfg="$1" key="$2"
    node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        console.log(JSON.parse(readFileSync('$cfg', 'utf8')).entries['$key'].genesis);
    "
}

# Process each --chain/--rpc pair in order.
for i in "${!CHAINS[@]}"; do
    chain="${CHAINS[$i]}"
    rpc="${RPCS[$i]}"
    echo ""
    echo "=== $chain ==="

    chain_dir="$CHAINS_DIR/$chain"
    cfg="$chain_dir/.papi/polkadot-api.json"
    backup="$cfg.bak.$$"

    original_genesis=$(read_genesis "$backup" "$(node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        console.log(Object.keys(JSON.parse(readFileSync('$backup','utf8')).entries)[0]);
    ")")

    # Patch config; `key` is the entry's identifier (e.g. paseo_asset_hub).
    key=$(patch_config_with_rpc "$cfg" "$rpc")

    # `papi update` re-fetches metadata + codeHash from `wsUrl`, rewrites
    # .papi/metadata/*.scale, and regenerates the TypeScript bindings.
    (cd "$chain_dir" && npx papi update "$key" --config "$cfg")

    new_genesis=$(read_genesis "$cfg" "$key")
    if [[ "$new_genesis" != "$original_genesis" ]]; then
        echo ""
        echo "  ⚠  Genesis drift detected on $chain:"
        echo "       was:  $original_genesis"
        echo "       now:  $new_genesis"
        echo "     The RPC you supplied is serving a different chain spec"
        echo "     than the bundled descriptor expects. Verify the RPC URL"
        echo "     before relying on the regenerated bindings."
    fi
done

echo ""
echo "✓ Done. Updated bindings live under chains/<name>/generated/dist/."
if ! $KEEP; then
    echo "  Restoring polkadot-api.json files (use --keep to retain RPC overrides)."
else
    echo "  Keeping polkadot-api.json overrides (per --keep)."
fi
