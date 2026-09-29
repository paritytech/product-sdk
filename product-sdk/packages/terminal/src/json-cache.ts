// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Versioned JSON cache files, one per `appId` and kind.
 *
 * @internal
 */
import { createLogger } from "@parity/product-sdk-logger";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const log = createLogger("terminal");

export const DEFAULT_STORAGE_DIR = join(homedir(), ".polkadot-apps");
const CACHE_FILE_MODE = 0o600;

export interface VersionedCache {
    version: number;
}

function sanitizeAppId(appId: string): string {
    return appId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function cacheFilePath(appId: string, kind: string, storageDir?: string): string {
    return join(storageDir ?? DEFAULT_STORAGE_DIR, `${sanitizeAppId(appId)}_${kind}.json`);
}

/**
 * Read a cache file, or `null` when absent, unparseable, or written by another
 * schema version. Dropped rather than half-read: its entries belong to a shape
 * this build no longer understands.
 */
export async function loadJsonCache<T extends VersionedCache>(
    path: string,
    version: number,
    label: string,
): Promise<T | null> {
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw e;
    }
    try {
        const parsed = JSON.parse(raw) as T;
        if (parsed?.version !== version) {
            log.warn(`${label} schema mismatch; starting fresh`, { path });
            return null;
        }
        return parsed;
    } catch (e) {
        log.warn(`${label} parse failed; starting fresh`, { path, error: String(e) });
        return null;
    }
}

/**
 * Temp + rename so a crash cannot leave a half-written file. The temp name is
 * unique per write because a shared one collides: the first rename consumes the
 * file the second writer is about to move.
 */
export async function saveJsonCache<T extends VersionedCache>(
    path: string,
    value: T,
): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: CACHE_FILE_MODE });
    await rename(tmp, path);
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Without this, concurrent callers each snapshot the file before the other
 * writes and the loser's entries are lost. Cross-process writes still race, but
 * converge: the Account Holder answers every caller alike for a given key.
 */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(path) ?? Promise.resolve();
    // Neutralize a prior rejection so one failure does not block later waiters.
    const next = prev.catch(() => {}).then(fn);
    locks.set(
        path,
        next.catch(() => {}),
    );
    return next;
}
