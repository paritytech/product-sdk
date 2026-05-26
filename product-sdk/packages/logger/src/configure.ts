// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { state } from "./state.js";
import type { LoggerConfig } from "./types.js";

/**
 * Apply global logger configuration. Merges into prior settings — passed fields
 * replace, omitted fields are left alone — and takes effect immediately for
 * every {@link Logger}, present and future.
 */
export function configure(config: LoggerConfig): void {
    if (config.level !== undefined) {
        state.level = config.level;
    }
    if (config.namespaces !== undefined) {
        state.namespaces = config.namespaces.length > 0 ? new Set(config.namespaces) : undefined;
    }
    if (config.handler !== undefined) {
        state.handler = config.handler;
    }
}
