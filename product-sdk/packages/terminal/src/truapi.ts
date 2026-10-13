// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `@parity/product-sdk-terminal/truapi` — experimental, opt-in backend that
 * runs truapi's pairing host in Node instead of `@novasamatech/host-papp`.
 *
 * ```ts
 * import { createTruapiTerminal, createTruapiSigner, renderQrCode } from "@parity/product-sdk-terminal/truapi";
 *
 * const terminal = await createTruapiTerminal({ appId: "my-cli.dot" });
 * await terminal.login({ onPairing: async (link) => console.log(await renderQrCode(link)) });
 * const signer = await createTruapiSigner(terminal);
 * ```
 *
 * Sessions live under `~/.polkadot-apps/truapi/`, separate from host-papp
 * sessions, so the first run on this backend pairs again. Product account
 * addresses are the same on both backends.
 */
import type {
    AllocatableResource,
    AllocationOutcome,
    Statement,
    StatementProof,
} from "@parity/truapi";

import type { TruapiTerminal } from "./truapi/runtime.js";

export { createTruapiTerminal, defaultTruapiStorageDir } from "./truapi/runtime.js";
export type { TruapiTerminal, TruapiTerminalOptions, LoginOptions } from "./truapi/runtime.js";
export { createTruapiSigner, buildProductTxPayload } from "./truapi/signer.js";
export type { TruapiAccountRef } from "./truapi/signer.js";
export { TruapiNetworks } from "./truapi/networks.js";
export type { TruapiNetwork, TruapiNetworkName, TruapiChain } from "./truapi/networks.js";
export { renderQrCode } from "./qr-encode.js";
export type { AuthState, SessionUiInfo } from "@parity/truapi-host";

const toHex = (bytes: Uint8Array): `0x${string}` => `0x${Buffer.from(bytes).toString("hex")}`;
const fail = (what: string, error: unknown): never => {
    throw new Error(`${what} failed: ${JSON.stringify(error)}`);
};

/**
 * Product-scoped deterministic entropy for `context`. Counterpart of
 * `deriveEntropy`, but derived by the wallet: the value differs from the
 * host-papp backend's, which derives locally from the session's root entropy.
 */
export async function deriveEntropy(
    terminal: TruapiTerminal,
    context: Uint8Array,
): Promise<Uint8Array> {
    const result = await terminal.client.entropy.derive({ context: toHex(context) });
    if (result.isErr()) return fail("deriveEntropy", result.error);
    return new Uint8Array(Buffer.from(result.value.entropy.slice(2), "hex"));
}

/**
 * Ask the wallet to allocate host-managed resources (statement-store or
 * Bulletin allowance, ...). Counterpart of `requestResourceAllocation`; truapi
 * has no `onExisting` policy, the wallet decides reuse.
 */
export async function requestResourceAllocation(
    terminal: TruapiTerminal,
    resources: AllocatableResource[],
): Promise<AllocationOutcome[]> {
    const result = await terminal.client.resourceAllocation.request({ resources });
    if (result.isErr()) return fail("requestResourceAllocation", result.error);
    return result.value.outcomes;
}

/**
 * Prove a statement with the product's statement-store allowance key.
 * Counterpart of `getStatementStoreProver`. Allocate `StatementStoreAllowance`
 * first.
 */
export async function createStatementProof(
    terminal: TruapiTerminal,
    statement: Statement,
): Promise<StatementProof> {
    const result = await terminal.client.statementStore.createProofAuthorized(statement);
    if (result.isErr()) return fail("createStatementProof", result.error);
    return result.value.proof;
}

/** Submit a proved statement to the People chain's statement store. */
export async function submitStatement(
    terminal: TruapiTerminal,
    statement: Statement & { proof: StatementProof },
): Promise<void> {
    const result = await terminal.client.statementStore.submit(statement);
    if (result.isErr()) fail("submitStatement", result.error);
}
