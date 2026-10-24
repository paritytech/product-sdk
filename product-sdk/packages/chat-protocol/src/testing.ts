// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Stand-ins for the protocol's ports, for tests: a statement store with the
 * People chain's admission rules and switchable faults, a HOP node, local provers
 * and test identities, a directory, chat keys, delivery and push.
 *
 * @module
 */
export * from "./stand-ins/statementStore.js";
export * from "./stand-ins/hop.js";
export * from "./stand-ins/keys.js";
export * from "./stand-ins/host.js";
export { ManualClock, settle } from "@parity/product-sdk-utils/testing";
export * from "./stand-ins/vectors.js";
