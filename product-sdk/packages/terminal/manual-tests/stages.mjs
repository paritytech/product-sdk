// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Statement-store endpoint selection shared by the manual scripts.
 *
 * The CLI and the phone must be on the same people chain or authenticate()
 * times out after two minutes with nothing explaining why, so an unknown
 * SS_STAGE throws rather than falling back to a chain the phone is not on.
 */
import { SS_STABLE_STAGE_ENDPOINTS, StatementStoreNetworks } from "@parity/product-sdk-terminal";

const SS_STAGES = {
    ...StatementStoreNetworks,
    stable: SS_STABLE_STAGE_ENDPOINTS,
};

export const STAGE_NAMES = Object.keys(SS_STAGES);

/** Endpoints from SS_ENDPOINTS if set, else the SS_STAGE preset, default `paseo`. */
export function resolveEndpoints() {
    if (process.env.SS_ENDPOINTS) {
        return process.env.SS_ENDPOINTS.split(",").map((s) => s.trim());
    }
    const stage = process.env.SS_STAGE ?? "paseo";
    if (!Object.hasOwn(SS_STAGES, stage)) {
        throw new Error(`Unknown SS_STAGE "${stage}". Use one of: ${STAGE_NAMES.join(", ")}`);
    }
    return SS_STAGES[stage];
}
