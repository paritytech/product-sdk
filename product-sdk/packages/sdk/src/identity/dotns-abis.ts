// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal ABIs for the DotNS contracts: the read and write methods this module
 * calls, and nothing else. Sourced from `paritytech/dotns` (`contracts/registry`,
 * `contracts/resolvers`, `contracts/registrars`, `contracts/pop`).
 */
import type { AbiEntry } from "@parity/product-sdk-contracts";

/**
 * `DotnsRegistry` — node → resolver / owner, plus the owner-gated pointer write.
 *
 * `setResolver` is needed because registration parks `records[node].resolver` on
 * the reverse resolver, so the pointer must be moved once before any address
 * record is readable.
 */
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
    {
        type: "function",
        name: "setResolver",
        inputs: [
            { name: "node", type: "bytes32" },
            { name: "resolverAddr", type: "address" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
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

/**
 * `PopRules` — registration pricing.
 *
 * `price` is the label-only cost and runs no eligibility rules, so it is not
 * what `register` charges. `register` uses the owner-aware variants and adds
 * `transferFloor` when the payer is not the owner:
 * `max(priceWithoutCheck(label, owner).price, transferFloor(label, payer, owner))`.
 *
 * `PopStatus` encodes as `uint8`: 0 NoStatus, 1 PopLite, 2 PopFull, 3 Reserved.
 */
export const DOTNS_POP_RULES_ABI: AbiEntry[] = [
    {
        type: "function",
        name: "price",
        inputs: [{ name: "name", type: "string" }],
        outputs: [{ name: "cost", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "priceWithoutCheck",
        inputs: [
            { name: "name", type: "string" },
            { name: "userAddress", type: "address" },
        ],
        outputs: [
            {
                name: "metadata",
                type: "tuple",
                components: [
                    { name: "price", type: "uint256" },
                    { name: "status", type: "uint8" },
                    { name: "userStatus", type: "uint8" },
                    { name: "message", type: "string" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "transferFloor",
        inputs: [
            { name: "name", type: "string" },
            { name: "from", type: "address" },
            { name: "to", type: "address" },
        ],
        outputs: [{ name: "floor", type: "uint256" }],
        stateMutability: "view",
    },
];

/** `IPopRules.PopStatus`. Ordering is meaningful: a user meets a tier when `userStatus >= status`. */
export const POP_STATUS = { NoStatus: 0, PopLite: 1, PopFull: 2, Reserved: 3 } as const;

/**
 * Default deployed addresses on Paseo Asset Hub (chain id 420420417).
 *
 * Verified on 2026-08-18 against the live chain, not copied from a file: every
 * address below answers `DotnsProtocolRegistry.get(bytes32)` on
 * `wss://paseo-asset-hub-next-rpc.polkadot.io` under its `DotnsConstants` key,
 * and each has a `Revive.AccountInfoOf` entry. They also match
 * `paritytech/dotns` `deployments/paseo-assethub/420420417.json` at commit
 * `82ac5e64`.
 *
 * These are pinned, not resolved at runtime, so re-verify after a redeploy.
 * The check is a `get(bytes32)` query per key against `protocolRegistry`, where
 * the key is the name below right-padded to 32 bytes (`bytes32("registry")`).
 *
 * `protocolRegistry` is the contract the others register themselves with. It is
 * not used on the resolution path today, but it is the address to go through if
 * we ever resolve the rest dynamically (`get(bytes32 key)` with the
 * `DotnsConstants` keys) instead of pinning them here.
 */
export const PASEO_ASSETHUB_DOTNS = {
    registry: "0xf34054fd76BbF85f216cf9908226D5f0A72E50CA",
    reverseResolver: "0xee3883d7eB60Ee9BCD7F3bcD8f2f05302A9Cc035",
    resolver: "0xbd1165E549DF96F083c0A16f61590927bC187009",
    registrarController: "0xBdaA01bD1bA67d709F2b1fF286Da0d854977EA30",
    popRules: "0x747B456bE03aec0b42bd85C51513730FBD45DA31",
    protocolRegistry: "0xD19e3D0C97CF501125a04A97405e3e6592fa846E",
} as const;
