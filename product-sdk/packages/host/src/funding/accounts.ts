// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Accounts a funding provider derives from host entropy (RFC-0007): one per
 * user and provider for each label, the same after a restart, with no secret
 * to store.
 *
 * @module
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import type { HexString, PaymentTopUpSource } from "@parity/truapi";
import { ss58Encode } from "@parity/product-sdk-address";
import { blake2b256, sr25519KeypairFromSeed, sr25519Sign } from "@parity/product-sdk-crypto";
import { getTxCreator } from "polkadot-api/tx-creator";

import { fromHex, toHex } from "../truapi.js";
import { type FundingClient, call } from "./client.js";

const LABEL_PREFIX = "product-sdk:funding-provider:account:v1:";

/** An sr25519 account derived from host entropy. */
export interface EntropyAccount {
    /** 32-byte public key. */
    publicKey: Uint8Array;
    /** SS58 address under the prefix it was derived with (default 42). */
    ss58Address: string;
    /** Signs transactions from this account. */
    signer: CommonSignerTxCreator;
    /** Sign raw bytes. */
    signBytes(message: Uint8Array): Uint8Array;
    /** The source `payment.topUp` takes to pull this account's funds into the user's balance. */
    topUpSource(): PaymentTopUpSource;
}

/**
 * The 32-byte entropy context for `label`:
 * `blake2b-256("product-sdk:funding-provider:account:v1:" + label)`, which fits
 * the host's context size whatever the label's length.
 */
export function accountContext(label: string): HexString {
    return toHex(blake2b256(new TextEncoder().encode(LABEL_PREFIX + label)));
}

/**
 * Derive the account for `label` from host entropy: the host derives a seed
 * scoped to the user and this provider's product, which expands into an
 * sr25519 key the way Substrate expands a mini secret key.
 *
 * Labels by convention: `"session/<intent>"` for an account that belongs to
 * one session, `"reserve"` for one the provider keeps per user.
 */
export async function deriveEntropyAccount(
    client: Pick<FundingClient, "entropy">,
    label: string,
    options: { ss58Prefix?: number } = {},
): Promise<EntropyAccount> {
    const { entropy } = await call(
        client.entropy.derive({ context: accountContext(label) }),
        "entropy.derive",
    );
    const seed = fromHex(entropy);
    const { publicKey, secretKey } = sr25519KeypairFromSeed(
        seed.length === 32 ? seed : blake2b256(seed),
    );
    const sign = (message: Uint8Array) => sr25519Sign(secretKey, message);
    return {
        publicKey,
        ss58Address: ss58Encode(publicKey, options.ss58Prefix ?? 42),
        signer: getTxCreator(publicKey, "Sr25519", sign),
        signBytes: sign,
        topUpSource: () => ({ tag: "PrivateKey", value: { sr25519SecretKey: toHex(secretKey) } }),
    };
}

if (import.meta.vitest) {
    const { test, expect } = import.meta.vitest;
    const { okAsync } = await import("neverthrow");

    const fakeEntropy = {
        entropy: {
            derive: ({ context }: { context: HexString }) =>
                okAsync({ entropy: toHex(blake2b256(fromHex(context))) }),
        },
    } as unknown as Pick<FundingClient, "entropy">;

    test("the same label derives the same account", async () => {
        const a = await deriveEntropyAccount(fakeEntropy, "session/i");
        const b = await deriveEntropyAccount(fakeEntropy, "session/i");
        expect(a.publicKey).toEqual(b.publicKey);
        expect(a.ss58Address).toBe(b.ss58Address);
    });

    test("labels derive different accounts", async () => {
        const a = await deriveEntropyAccount(fakeEntropy, "session/i");
        const b = await deriveEntropyAccount(fakeEntropy, "reserve");
        expect(a.publicKey).not.toEqual(b.publicKey);
    });

    test("the top-up source carries the 64-byte secret", async () => {
        const account = await deriveEntropyAccount(fakeEntropy, "reserve");
        const source = account.topUpSource();
        expect(source.tag).toBe("PrivateKey");
        if (source.tag === "PrivateKey") {
            expect(source.value.sr25519SecretKey).toMatch(/^0x[0-9a-f]{128}$/);
        }
    });
}
