import type { PolkadotSigner } from "polkadot-api";

/**
 * Build a `PolkadotSigner` whose underlying signer is resolved on every call.
 *
 * `AsyncBulletinClient` takes a fixed `PolkadotSigner` at construction, but
 * apps often build the Cloud Storage client before any account is selected. This
 * wrapper defers signer resolution: each call to `signTx` / `signBytes`
 * invokes `getSigner()` and forwards to the result. If the getter returns
 * `null`, calls throw with a clear message.
 *
 * The `publicKey` field is *also* resolved lazily — accessing it before a
 * signer is available throws. This means callers that read `publicKey`
 * eagerly will fail fast with the same error rather than seeing a stale
 * key from a previously-selected account.
 *
 * Account changes between calls are picked up automatically: each sign
 * resolves the current signer.
 */
export function createLazySigner(
    getSigner: () => PolkadotSigner | null,
    onMissing = "No signer available — connect a wallet and select an account first.",
): PolkadotSigner {
    const resolve = (): PolkadotSigner => {
        const inner = getSigner();
        if (!inner) throw new Error(onMissing);
        return inner;
    };

    // `async` on the methods is deliberate: it converts a "no signer" throw
    // from `resolve()` into a rejected Promise. PolkadotSigner.signTx /
    // signBytes are typed as returning Promises, and consumers expect a
    // rejection rather than a synchronous escape on the failure path.
    const lazy: PolkadotSigner = {
        get publicKey() {
            return resolve().publicKey;
        },
        signTx: async (...args: Parameters<PolkadotSigner["signTx"]>) => resolve().signTx(...args),
        signBytes: async (...args: Parameters<PolkadotSigner["signBytes"]>) =>
            resolve().signBytes(...args),
    };
    return lazy;
}

if (import.meta.vitest) {
    const { describe, test, expect, vi } = import.meta.vitest;

    function makeMockSigner(label: string): PolkadotSigner {
        return {
            publicKey: new TextEncoder().encode(label),
            signTx: vi.fn().mockResolvedValue(new Uint8Array([1])),
            signBytes: vi.fn().mockResolvedValue(new Uint8Array([2])),
        };
    }

    describe("createLazySigner", () => {
        test("publicKey throws when getter returns null", () => {
            const lazy = createLazySigner(() => null);
            expect(() => lazy.publicKey).toThrow("No signer available");
        });

        test("publicKey resolves through getter when signer is available", () => {
            const inner = makeMockSigner("alice");
            const lazy = createLazySigner(() => inner);
            expect(lazy.publicKey).toBe(inner.publicKey);
        });

        test("signTx throws when getter returns null", async () => {
            const lazy = createLazySigner(() => null);
            await expect(lazy.signTx(new Uint8Array(), {}, new Uint8Array(), 0)).rejects.toThrow(
                "No signer available",
            );
        });

        test("signTx forwards to current signer", async () => {
            const inner = makeMockSigner("alice");
            const lazy = createLazySigner(() => inner);
            const callData = new Uint8Array([0xaa, 0xbb]);
            const signedExtensions = {};
            const metadata = new Uint8Array([0xcc]);
            const atBlock = 42;
            const result = await lazy.signTx(callData, signedExtensions, metadata, atBlock);
            expect(inner.signTx).toHaveBeenCalledWith(
                callData,
                signedExtensions,
                metadata,
                atBlock,
            );
            expect(result).toEqual(new Uint8Array([1]));
        });

        test("signBytes forwards to current signer", async () => {
            const inner = makeMockSigner("bob");
            const lazy = createLazySigner(() => inner);
            const result = await lazy.signBytes(new Uint8Array([9]));
            expect(inner.signBytes).toHaveBeenCalledWith(new Uint8Array([9]));
            expect(result).toEqual(new Uint8Array([2]));
        });

        test("picks up account changes between calls", () => {
            let active: PolkadotSigner | null = makeMockSigner("first");
            const lazy = createLazySigner(() => active);
            expect(lazy.publicKey).toEqual(new TextEncoder().encode("first"));
            active = makeMockSigner("second");
            expect(lazy.publicKey).toEqual(new TextEncoder().encode("second"));
        });

        test("custom error message", () => {
            const lazy = createLazySigner(() => null, "select an account first");
            expect(() => lazy.publicKey).toThrow("select an account first");
        });
    });
}
