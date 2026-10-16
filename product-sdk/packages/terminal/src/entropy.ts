// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic product entropy from the paired wallet: RFC-0007, host-spec
 * §C.8. The core derives it from the root entropy source the wallet shares at
 * pairing, so the same wallet, product and key give the same bytes here and in
 * a container.
 */
import { fromHex, toHex } from "@polkadot-api/utils";

import type { TerminalAdapter } from "./adapter.js";
import { describeCallError } from "./call-error.js";

/**
 * 32 bytes of entropy scoped to `productId` and `key` (1 to 32 bytes).
 *
 * `productId` is the identifier the product is served under in a container,
 * e.g. `"my-app.dot"`. The core trims, NFC-normalises and lowercases it first,
 * so `"My-App.dot"` and `"my-app.dot"` give the same bytes.
 */
export async function deriveEntropy(
    adapter: TerminalAdapter,
    productId: string,
    key: Uint8Array,
): Promise<Uint8Array> {
    const client = await adapter.client(productId);
    const derived = await client.entropy.derive({
        context: toHex(key) as `0x${string}`,
    });
    if (derived.isErr())
        throw new Error(`deriveEntropy failed: ${describeCallError(derived.error)}`);
    return fromHex(derived.value.entropy);
}
