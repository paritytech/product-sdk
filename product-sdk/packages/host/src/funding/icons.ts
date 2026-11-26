// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where a provider puts its network and token icons: in its worker archive,
 * the executable that declares `includes.funding`, not its app archive.
 * The host reads them from there to show next to the provider's routes and
 * quotes.
 *
 * | Path | Name |
 * |---|---|
 * | `funding/icons/networks/<network>.png` | the network id, lowercase: `polkadot`, `ethereum` |
 * | `funding/icons/tokens/<token>.png` | the token symbol, lowercase: `dot`, `usdc` |
 *
 * Paths are relative to the archive root. Each icon is a square
 * {@link FUNDING_ICON_SIZE} px PNG with a transparent background. A missing
 * icon is fine: the host shows a monogram, never another provider's icon.
 *
 * @module
 */

/** The folder, relative to the archive root, that holds a provider's funding icons. */
export const FUNDING_ICONS_DIR = "funding/icons";

/** Width and height of every funding icon, in px. */
export const FUNDING_ICON_SIZE = 96;

const NAME = /^[a-z0-9-]+$/;

function iconPath(kind: "networks" | "tokens", id: string): string | undefined {
    const name = id.toLowerCase();
    return NAME.test(name) ? `${FUNDING_ICONS_DIR}/${kind}/${name}.png` : undefined;
}

/**
 * The archive path of the icon for `network`, the id the provider quotes
 * under, such as `"polkadot"`: `funding/icons/networks/polkadot.png`.
 *
 * The id is lowercased, as the host does. `undefined` when it has a
 * character outside `[a-z0-9-]` after that: the host looks up no icon for
 * it and shows a monogram.
 */
export function fundingNetworkIconPath(network: string): string | undefined {
    return iconPath("networks", network);
}

/**
 * The archive path of the icon for the token `symbol`, such as `"USDC"`:
 * `funding/icons/tokens/usdc.png`.
 *
 * The symbol is lowercased, as the host does. `undefined` when it has a
 * character outside `[a-z0-9-]` after that: the host looks up no icon for
 * it and shows a monogram.
 */
export function fundingTokenIconPath(symbol: string): string | undefined {
    return iconPath("tokens", symbol);
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;

    test("network icons sit under funding/icons/networks", () => {
        expect(fundingNetworkIconPath("polkadot")).toBe("funding/icons/networks/polkadot.png");
        expect(fundingNetworkIconPath("asset-hub")).toBe("funding/icons/networks/asset-hub.png");
    });

    test("token icons sit under funding/icons/tokens", () => {
        expect(fundingTokenIconPath("dot")).toBe("funding/icons/tokens/dot.png");
        expect(fundingTokenIconPath("usdt0")).toBe("funding/icons/tokens/usdt0.png");
    });

    test("ids are lowercased", () => {
        expect(fundingNetworkIconPath("Ethereum")).toBe("funding/icons/networks/ethereum.png");
        expect(fundingTokenIconPath("USDC")).toBe("funding/icons/tokens/usdc.png");
        expect(fundingTokenIconPath("DOTUSD")).toBe("funding/icons/tokens/dotusd.png");
    });

    test("ids outside [a-z0-9-] have no icon", () => {
        for (const id of ["", "usdc.e", "../dot", "dot/x", "dot ", "usd₮", "a_b", "%2e"]) {
            expect(fundingTokenIconPath(id)).toBeUndefined();
            expect(fundingNetworkIconPath(id)).toBeUndefined();
        }
    });
}
