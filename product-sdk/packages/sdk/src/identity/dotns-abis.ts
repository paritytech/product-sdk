// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal ABIs for the DotNS resolution contracts — only the read methods this
 * module calls. Sourced from `paritytech/dotns` (`contracts/registry`,
 * `contracts/resolvers`). Extend these subsets when wiring writes.
 */
import type { AbiEntry } from "@parity/product-sdk-contracts";

/** `DotnsRegistry` — node → resolver / owner. */
export const DOTNS_REGISTRY_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "resolver",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "owner",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
];

/** `DotnsResolver` — node → resolved address. */
export const DOTNS_RESOLVER_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "addressOf",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "value", type: "address" }],
        stateMutability: "view",
    },
];

/** `DotnsReverseResolver` — account → primary name. */
export const DOTNS_REVERSE_RESOLVER_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "nameOf",
        inputs: [{ name: "addr", type: "address" }],
        outputs: [{ name: "name", type: "string" }],
        stateMutability: "view",
    },
];

/**
 * Default deployed addresses on Paseo Asset Hub, from
 * `dotns/deployments/paseo-assethub/420420417.json`.
 *
 * TODO(dotns-addr): a teammate cited a different StoreFactory address
 * (`0x709A027F…`) than this deployment (`0x030296…`); confirm which Paseo AH
 * deployment is live before relying on these for anything beyond dev.
 */
export const PASEO_ASSETHUB_DOTNS = {
    registry: "0x4Da0d37aBe96C06ab19963F31ca2DC0412057a6f",
    reverseResolver: "0x95D57363B491CF743970c640fe419541386ac8BF",
} as const;
