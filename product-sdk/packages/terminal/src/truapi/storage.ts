// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * File-backed core storage for the truapi pairing host.
 *
 * The core persists its own state (auth session, pairing identity, allowance
 * keys, permission decisions, ...) through these three callbacks. Each key is
 * one file. Keys are SCALE-encoded `CoreStorageKey`s, and some embed product
 * and account ids, so the encoded key is hashed rather than used as the
 * filename: hex of a raw `AllowanceKeys` key overflows the 255-byte limit.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { encodeCoreStorageKey, type CoreStorageKey } from "@parity/truapi-host";

export interface CoreStorage {
    readCoreStorage(key: CoreStorageKey): Promise<Uint8Array | undefined>;
    writeCoreStorage(key: CoreStorageKey, value: Uint8Array): Promise<void>;
    clearCoreStorage(key: CoreStorageKey): Promise<void>;
}

/** Filename for one core storage key: readable tag plus a 128-bit digest. */
export function coreStorageFileName(key: CoreStorageKey): string {
    const digest = createHash("sha256").update(encodeCoreStorageKey(key)).digest("hex");
    return `${key.tag}-${digest.slice(0, 32)}.bin`;
}

export function createFileCoreStorage(dir: string): CoreStorage {
    const path = (key: CoreStorageKey) => join(dir, coreStorageFileName(key));
    return {
        async readCoreStorage(key) {
            try {
                return new Uint8Array(await readFile(path(key)));
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
                throw e;
            }
        },
        async writeCoreStorage(key, value) {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            // Write-then-rename so a crash mid-write never leaves a torn session.
            const target = path(key);
            const tmp = `${target}.${process.pid}.tmp`;
            await writeFile(tmp, value, { mode: 0o600 });
            await rename(tmp, target);
        },
        async clearCoreStorage(key) {
            await unlink(path(key)).catch((e: NodeJS.ErrnoException) => {
                if (e.code !== "ENOENT") throw e;
            });
        },
    };
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest;
    const { mkdtemp, rm, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "terminal-truapi-storage-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("coreStorageFileName", () => {
        test("is deterministic and keeps the tag readable", () => {
            const key: CoreStorageKey = { tag: "AuthSession" };
            expect(coreStorageFileName(key)).toBe(coreStorageFileName({ tag: "AuthSession" }));
            expect(coreStorageFileName(key)).toMatch(/^AuthSession-[0-9a-f]{32}\.bin$/);
        });

        test("stays short for keys that embed long ids", () => {
            const key = {
                tag: "PermissionAuthorization",
                value: { productId: "a".repeat(300), request: { tag: "IdentityDisclosure" } },
            } as unknown as CoreStorageKey;
            expect(coreStorageFileName(key).length).toBeLessThan(100);
        });
    });

    describe("createFileCoreStorage", () => {
        test("missing key reads as undefined", async () => {
            const s = createFileCoreStorage(dir);
            expect(await s.readCoreStorage({ tag: "AuthSession" })).toBeUndefined();
        });

        test("write, read, clear round-trip", async () => {
            const s = createFileCoreStorage(dir);
            const key: CoreStorageKey = { tag: "PairingDeviceIdentity" };
            await s.writeCoreStorage(key, new Uint8Array([1, 2, 3]));
            expect(await s.readCoreStorage(key)).toEqual(new Uint8Array([1, 2, 3]));
            await s.clearCoreStorage(key);
            expect(await s.readCoreStorage(key)).toBeUndefined();
        });

        test("clearing a missing key is not an error", async () => {
            const s = createFileCoreStorage(dir);
            await expect(s.clearCoreStorage({ tag: "AuthSession" })).resolves.toBeUndefined();
        });

        test("leaves no temp files behind", async () => {
            const s = createFileCoreStorage(dir);
            await s.writeCoreStorage({ tag: "AuthSession" }, new Uint8Array([9]));
            expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
        });
    });
}
