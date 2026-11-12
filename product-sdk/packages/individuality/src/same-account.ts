// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Whether two SS58 strings name the same account. The chain's SS58 prefix need
 * not be the caller's, so the strings are compared as the account ids they
 * decode to. Throws on a string that is not an address, as the codec does.
 *
 * Internal: shared by the lite sign-up read and the registration flow, not part
 * of the package surface.
 */
import { AccountId } from "polkadot-api";

export function sameAccount(left: string, right: string): boolean {
    const codec = AccountId();
    const a = codec.enc(left);
    const b = codec.enc(right);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

if (import.meta.vitest) {
    const { expect, test } = import.meta.vitest;

    test("matches one account written with two SS58 prefixes", () => {
        const id = new Uint8Array(32).fill(7);
        const generic = AccountId(42).dec(id);
        const polkadot = AccountId(0).dec(id);
        expect(generic).not.toBe(polkadot);
        expect(sameAccount(generic, polkadot)).toBe(true);
    });

    test("tells two accounts apart", () => {
        const a = AccountId().dec(new Uint8Array(32).fill(1));
        const b = AccountId().dec(new Uint8Array(32).fill(2));
        expect(sameAccount(a, b)).toBe(false);
    });
}
