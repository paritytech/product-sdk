// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Slot-account signer: reads the cached Bulletin/SSS allowance key and
 * returns a `PolkadotSigner` that signs locally with sr25519. SC and
 * AutoSigning are not slot-table variants and throw.
 *
 * @module
 */
import { bytesToNumberLE, numberToBytesLE } from "@noble/curves/utils.js";
import { fromHex } from "@polkadot-api/utils";
import { createDerive, sr25519, sr25519Derive } from "@polkadot-labs/hdkd-helpers";
import type { PolkadotSigner } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";

import type { TerminalAdapter } from "./adapter.js";
import { type CachedAllocation, loadCache, readCacheEntry } from "./host-cache.js";
import type { AllocatableResource } from "./host.js";

// schnorrkel to_bytes() (canonical scalar) -> to_ed25519_bytes() form @scure expects (×8 cofactor).
function canonicalSr25519SecretToEd25519Bytes(secret: Uint8Array): Uint8Array {
    const ed25519Scalar = numberToBytesLE(bytesToNumberLE(secret.subarray(0, 32)) << 3n, 32);
    const out = new Uint8Array(64);
    out.set(ed25519Scalar, 0);
    out.set(secret.subarray(32, 64), 32);
    return out;
}

// Wire encoding for slotAccountKey isn't pinned: mobile may send a
// 32-byte mini-secret or a 64-byte expanded secret. Detect length and
// route; any other length throws.
function buildKeypair(secret: Uint8Array): {
    publicKey: Uint8Array;
    sign: (data: Uint8Array) => Uint8Array;
} {
    if (secret.length === 32) {
        const derive = createDerive({ seed: secret, curve: sr25519, derive: sr25519Derive });
        const keypair = derive("");
        return { publicKey: keypair.publicKey, sign: (data) => keypair.sign(data) };
    }
    if (secret.length === 64) {
        const ed25519Secret = canonicalSr25519SecretToEd25519Bytes(secret);
        return {
            publicKey: sr25519.getPublicKey(ed25519Secret),
            sign: (data) => sr25519.sign(data, ed25519Secret),
        };
    }
    throw new Error(
        `createSlotAccountSigner: unexpected slotAccountKey length ${secret.length}. Expected 32 (mini-secret) or 64 (expanded secret).`,
    );
}

/**
 * Build a `PolkadotSigner` from an already-loaded cache entry. Throws
 * for SC and AutoSigning — they don't carry a slot account key. See
 * the module docstring.
 *
 * Useful when the caller already holds the cache in memory, e.g. inside
 * a `withCacheLock` block, and wants to avoid re-reading disk.
 */
export function buildSignerFromEntry(entry: CachedAllocation): PolkadotSigner {
    if (entry.tag !== "BulletInAllowance" && entry.tag !== "StatementStoreAllowance") {
        throw new Error(
            `createSlotAccountSigner: ${entry.tag} does not carry a slot account key. Slot-table signing is defined for BulletInAllowance and StatementStoreAllowance only.`,
        );
    }
    const secret = fromHex(entry.slotAccountKey);
    const { publicKey, sign } = buildKeypair(secret);
    return getPolkadotSigner(publicKey, "Sr25519", async (data) => sign(data));
}

/**
 * `PolkadotSigner` backed by the cached slot account key. Returns `null`
 * when nothing's cached for `(adapter.appId, resource)`. Throws for SC
 * and AutoSigning (no slot account key — see module docstring).
 *
 * Signs locally with sr25519 — no wallet round-trip on the hot path.
 *
 * @example
 * ```ts
 * const signer = await createSlotAccountSigner(adapter, {
 *   tag: "BulletInAllowance", value: undefined,
 * });
 * if (signer) await tx.submitAndWatch(signer);
 * ```
 */
export async function createSlotAccountSigner(
    adapter: TerminalAdapter,
    resource: AllocatableResource,
): Promise<PolkadotSigner | null> {
    const cache = await loadCache(adapter.appId, adapter.storageDir);
    const entry = readCacheEntry(cache, resource);
    if (!entry) return null;
    return buildSignerFromEntry(entry);
}

if (import.meta.vitest) {
    const { describe, test, expect, beforeEach } = import.meta.vitest;
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pathJoin } = await import("node:path");
    const { saveCache } = await import("./host-cache.js");
    const { DEV_PHRASE, mnemonicToMiniSecret } = await import("@polkadot-labs/hdkd-helpers");
    const { toHex } = await import("@polkadot-api/utils");

    let storageDir: string;
    beforeEach(() => {
        storageDir = mkdtempSync(pathJoin(tmpdir(), "host-signer-test-"));
        return () => rmSync(storageDir, { recursive: true, force: true });
    });

    function fakeAdapter(appId: string): TerminalAdapter {
        return { appId, storageDir } as unknown as TerminalAdapter;
    }

    function knownSecret(): {
        secret: Uint8Array;
        publicKey: Uint8Array;
        hex: string;
        sign: (msg: Uint8Array) => Uint8Array;
    } {
        // Deterministic across runs — uses the standard substrate dev
        // mnemonic. `mnemonicToMiniSecret` returns the 32-byte mini-secret
        // form (one of the two shapes `createSlotAccountSigner` accepts).
        const secret = mnemonicToMiniSecret(DEV_PHRASE);
        const derive = createDerive({ seed: secret, curve: sr25519, derive: sr25519Derive });
        const keypair = derive("");
        return {
            secret,
            publicKey: keypair.publicKey,
            hex: toHex(secret),
            sign: (msg) => keypair.sign(msg),
        };
    }

    describe("createSlotAccountSigner", () => {
        test("returns null when no allocation is cached", async () => {
            const adapter = fakeAdapter("p");
            const signer = await createSlotAccountSigner(adapter, {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signer).toBeNull();
        });

        test("returns a signer with the sr25519 public key derived from the cached secret", async () => {
            const { hex, publicKey } = knownSecret();
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: hex },
                    },
                },
                storageDir,
            );

            const signer = await createSlotAccountSigner(fakeAdapter("p"), {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signer).not.toBeNull();
            expect(signer?.publicKey).toEqual(publicKey);
        });

        test("signs locally and the signature verifies against the cached account", async () => {
            const { hex, publicKey } = knownSecret();
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: hex },
                    },
                },
                storageDir,
            );

            const signer = await createSlotAccountSigner(fakeAdapter("p"), {
                tag: "BulletInAllowance",
                value: undefined,
            });
            // `signBytes` wraps with `<Bytes>...</Bytes>` like all PAPI
            // PolkadotSigners do; for direct payload signing PAPI calls
            // `signTx` which routes through the same `sign` callback we
            // installed. Test that callback directly by reaching for the
            // typed surface: PAPI exposes signTx but the easiest direct
            // verification is `signBytes` which is wired through our sign.
            const payload = new TextEncoder().encode("hello slot");
            // signBytes wraps in <Bytes>...</Bytes> before calling our sign.
            // To verify, reconstruct the wrap manually.
            const wrapped = new Uint8Array([
                ...new TextEncoder().encode("<Bytes>"),
                ...payload,
                ...new TextEncoder().encode("</Bytes>"),
            ]);
            const signature = await signer!.signBytes(payload);
            expect(sr25519.verify(signature, wrapped, publicKey)).toBe(true);
        });

        test("64-byte expanded-secret form produces a valid signer", async () => {
            // Canonical schnorrkel to_bytes() for DEV_PHRASE (scalar + nonce), the mobile wire form.
            const SECRET_64_HEX =
                "0x05d65584630d16cd4af6d0bec10f34bb504a5dcb62dba2122d49f5a663763d0afd190cce74df356432b410bd64682309d6dedb27c76845daf388557cbac3ca34";

            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: {
                            tag: "BulletInAllowance",
                            slotAccountKey: SECRET_64_HEX,
                        },
                    },
                },
                storageDir,
            );

            const signer = await createSlotAccountSigner(fakeAdapter("p"), {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signer).not.toBeNull();

            // Public key from the 64-byte path matches the 32-byte path's
            // — same logical key, two encodings.
            const { publicKey: pubFrom32Bytes } = knownSecret();
            expect(signer?.publicKey).toEqual(pubFrom32Bytes);

            // Signature from the 64-byte branch verifies against the same
            // public key.
            const payload = new TextEncoder().encode("hello 64-byte path");
            const wrapped = new Uint8Array([
                ...new TextEncoder().encode("<Bytes>"),
                ...payload,
                ...new TextEncoder().encode("</Bytes>"),
            ]);
            const sig = await signer!.signBytes(payload);
            expect(sr25519.verify(sig, wrapped, pubFrom32Bytes)).toBe(true);
        });

        test("works for StatementStoreAllowance the same way", async () => {
            const { hex, publicKey } = knownSecret();
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        StatementStoreAllowance: {
                            tag: "StatementStoreAllowance",
                            slotAccountKey: hex,
                        },
                    },
                },
                storageDir,
            );

            const signer = await createSlotAccountSigner(fakeAdapter("p"), {
                tag: "StatementStoreAllowance",
                value: undefined,
            });
            expect(signer?.publicKey).toEqual(publicKey);
        });

        test("throws for SmartContractAllowance (no slot account key)", async () => {
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        "SmartContractAllowance::5": { tag: "SmartContractAllowance", dest: 5 },
                    },
                },
                storageDir,
            );

            await expect(
                createSlotAccountSigner(fakeAdapter("p"), {
                    tag: "SmartContractAllowance",
                    value: 5,
                }),
            ).rejects.toThrow(/SmartContractAllowance does not carry a slot account key/);
        });

        test("throws for AutoSigning (subtree key, not slot account)", async () => {
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        AutoSigning: {
                            tag: "AutoSigning",
                            productDerivationSecret: "secret",
                            productRootPrivateKey: "0xabcd",
                        },
                    },
                },
                storageDir,
            );

            await expect(
                createSlotAccountSigner(fakeAdapter("p"), {
                    tag: "AutoSigning",
                    value: undefined,
                }),
            ).rejects.toThrow(/AutoSigning does not carry a slot account key/);
        });

        test("different appIds yield different signers from disjoint caches", async () => {
            const a = knownSecret();
            // Distinct mini-secret → distinct derived keypair.
            const otherMiniSecret = new Uint8Array(32).fill(0x07);
            const otherKeypair = createDerive({
                seed: otherMiniSecret,
                curve: sr25519,
                derive: sr25519Derive,
            })("");

            await saveCache(
                "app-a",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: { tag: "BulletInAllowance", slotAccountKey: a.hex },
                    },
                },
                storageDir,
            );
            await saveCache(
                "app-b",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: {
                            tag: "BulletInAllowance",
                            slotAccountKey: toHex(otherMiniSecret),
                        },
                    },
                },
                storageDir,
            );

            const signerA = await createSlotAccountSigner(fakeAdapter("app-a"), {
                tag: "BulletInAllowance",
                value: undefined,
            });
            const signerB = await createSlotAccountSigner(fakeAdapter("app-b"), {
                tag: "BulletInAllowance",
                value: undefined,
            });
            expect(signerA?.publicKey).toEqual(a.publicKey);
            expect(signerB?.publicKey).toEqual(otherKeypair.publicKey);
            expect(signerA?.publicKey).not.toEqual(signerB?.publicKey);
        });

        test("rejects an unexpected slotAccountKey length", async () => {
            // Variable-length codec on the wire, but our keypair builder
            // only recognizes the standard 32 / 64 byte forms.
            await saveCache(
                "p",
                {
                    version: 1,
                    entries: {
                        BulletInAllowance: {
                            tag: "BulletInAllowance",
                            slotAccountKey: toHex(new Uint8Array(48).fill(1)),
                        },
                    },
                },
                storageDir,
            );

            await expect(
                createSlotAccountSigner(fakeAdapter("p"), {
                    tag: "BulletInAllowance",
                    value: undefined,
                }),
            ).rejects.toThrow(/unexpected slotAccountKey length 48/);
        });
    });
}
