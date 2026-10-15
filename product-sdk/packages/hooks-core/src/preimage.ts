// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type HexString,
    HostUnavailableError,
    type PreimageManager,
    getPreimageManager,
} from "@parity/product-sdk-host";
import type { HostController } from "./host.js";

export type { HexString, PreimageManager };

export interface PreimageController {
    /** Preimages are a host capability (Bulletin-backed); resolves null standalone. */
    getManager(): Promise<PreimageManager | null>;
    /**
     * Live lookup of the preimage behind `key`: `onValue` receives the bytes,
     * or `null` while the host is still searching. Standalone the subscription
     * reports `HostUnavailableError` through `onError`.
     */
    watch(
        key: HexString,
        onValue: (preimage: Uint8Array | null) => void,
        options?: { onError?: (error: unknown) => void },
    ): () => void;
    /** Submit a preimage through the host; resolves its `0x`-prefixed key (hash). */
    submit(value: Uint8Array): Promise<HexString>;
}

export function createPreimageController(host: HostController): PreimageController {
    let managerPromise: Promise<PreimageManager | null> | null = null;

    const getManager = (): Promise<PreimageManager | null> => {
        if (!managerPromise) {
            managerPromise = host.detect().then((inside) => (inside ? getPreimageManager() : null));
            managerPromise.catch(() => {
                managerPromise = null;
            });
        }
        return managerPromise;
    };

    const requireManager = async (): Promise<PreimageManager> => {
        const manager = await getManager();
        if (!manager) throw new HostUnavailableError("preimage");
        return manager;
    };

    return {
        getManager,
        watch: (key, onValue, options) => {
            let cancelled = false;
            let teardown: (() => void) | undefined;
            void requireManager()
                .then((manager) => {
                    if (cancelled) return;
                    const sub = manager.lookup(key, onValue);
                    const offInterrupt = sub.onInterrupt((reason) => options?.onError?.(reason));
                    teardown = () => {
                        offInterrupt();
                        sub.unsubscribe();
                    };
                    if (cancelled) teardown();
                })
                .catch((e) => {
                    if (!cancelled) options?.onError?.(e);
                });
            return () => {
                cancelled = true;
                teardown?.();
            };
        },
        submit: async (value) => (await requireManager()).submit(value),
    };
}
