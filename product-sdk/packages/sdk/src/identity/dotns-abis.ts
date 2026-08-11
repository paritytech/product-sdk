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

/** `DotnsResolver` write — set a node's resolved address (owner-gated). */
export const DOTNS_RESOLVER_WRITE_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "setAddress",
        inputs: [
            { name: "node", type: "bytes32" },
            { name: "value", type: "address" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
];

/**
 * `DotnsRegistrarController` — the commit-reveal registration flow. `register`
 * is payable; the value is the price from {@link DOTNS_POP_RULES_ABI}.
 * `Registration` = (label, owner, secret, reserved).
 */
export const DOTNS_REGISTRAR_CONTROLLER_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "available",
        inputs: [{ name: "label", type: "string" }],
        outputs: [{ name: "isAvailable", type: "bool" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "minCommitmentAge",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "maxCommitmentAge",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "makeCommitment",
        inputs: [
            {
                name: "registration",
                type: "tuple",
                components: [
                    { name: "label", type: "string" },
                    { name: "owner", type: "address" },
                    { name: "secret", type: "bytes32" },
                    { name: "reserved", type: "bool" },
                ],
            },
        ],
        outputs: [{ name: "commitment", type: "bytes32" }],
        stateMutability: "pure",
    },
    {
        type: "function",
        name: "commit",
        inputs: [{ name: "commitment", type: "bytes32" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "register",
        inputs: [
            {
                name: "registration",
                type: "tuple",
                components: [
                    { name: "label", type: "string" },
                    { name: "owner", type: "address" },
                    { name: "secret", type: "bytes32" },
                    { name: "reserved", type: "bool" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
];

/** `PopRules` — registration price for a label (payable value for `register`). */
export const DOTNS_POP_RULES_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "price",
        inputs: [{ name: "name", type: "string" }],
        outputs: [{ name: "cost", type: "uint256" }],
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
    resolver: "0x95645C7fD0fF38790647FE13F87Eb11c1DCc8514",
    registrarController: "0xd09e0F1c1E6CE8Cf40df929ef4FC778629573651",
    popRules: "0x4e8920B1E69d0cEA9b23CBFC87A17Ee6fE02d2d3",
} as const;
