// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
// Provider interface
export type { SignerProvider, Unsubscribe } from "./types.js";

// Dev provider (testnet accounts)
export { DevProvider } from "./dev.js";
export type { DevProviderOptions, DevAccountName, DevKeyType } from "./dev.js";

// Host provider (Polkadot Desktop / Mobile)
export { HostProvider } from "./host.js";
export type {
    HostProviderOptions,
    ProductAccount,
    ContextualAlias,
    RingLocation,
} from "./host.js";
