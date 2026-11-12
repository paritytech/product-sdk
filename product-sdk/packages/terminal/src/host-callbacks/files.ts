// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * One file per stored value. The truapi core persists the paired session and
 * its keys through these files, so writes are atomic and private to the user.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * File name for a storage key. Hashed because some keys embed product and
 * account ids long enough to overflow the 255-byte name limit; the readable
 * prefix keeps a directory listing debuggable.
 */
export function storageFileName(prefix: string, key: Uint8Array | string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return `${prefix}-${digest.slice(0, 32)}.bin`;
}

export async function readStoredFile(dir: string, name: string): Promise<Uint8Array | undefined> {
    try {
        return new Uint8Array(await readFile(join(dir, name)));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

export async function writeStoredFile(dir: string, name: string, value: Uint8Array): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, name);
    // Write then rename, so a crash mid-write never leaves a torn session. The
    // name is unique per write, so concurrent writes to one key never share it.
    const partial = `${target}.${randomUUID()}.partial`;
    await writeFile(partial, value, { mode: 0o600 });
    await rename(partial, target);
}

export async function removeStoredFile(dir: string, name: string): Promise<void> {
    await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
    });
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach, afterEach } = import.meta.vitest;
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");

    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "terminal-files-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    describe("storageFileName", () => {
        // A changed name would orphan every stored session, so the value is pinned.
        test("is short and keeps the prefix readable for keys of any length", () => {
            expect(storageFileName("AuthSession", "x".repeat(1000))).toBe(
                "AuthSession-44f8354494a5ba03ba1792a8d3e9c534.bin",
            );
        });
    });

    describe("stored files", () => {
        test("concurrent writes to one key all succeed and leave one of the written values", async () => {
            const values = Array.from({ length: 20 }, (_, i) => new Uint8Array(i + 1).fill(i));
            await Promise.all(values.map((value) => writeStoredFile(dir, "k.bin", value)));
            const stored = await readStoredFile(dir, "k.bin");
            expect({
                isAWrittenValue: values.some((value) =>
                    Buffer.from(value).equals(Buffer.from(stored!)),
                ),
                files: await readdir(dir),
            }).toEqual({ isAWrittenValue: true, files: ["k.bin"] });
        });

        test("round-trip, read back as missing once removed, and leave no partial files", async () => {
            await writeStoredFile(dir, "a.bin", new Uint8Array([1, 2, 3]));
            const written = await readStoredFile(dir, "a.bin");
            await removeStoredFile(dir, "a.bin");
            await removeStoredFile(dir, "a.bin");
            expect({
                written,
                afterRemove: await readStoredFile(dir, "a.bin"),
                files: await readdir(dir),
            }).toEqual({
                written: new Uint8Array([1, 2, 3]),
                afterRemove: undefined,
                files: [],
            });
        });
    });
}
