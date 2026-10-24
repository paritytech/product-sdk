// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    AccountNamesCodec,
    accountNamesKey,
    chatKeyContainer,
    decodeAccountNames,
    decodeSs58,
    filled,
    peerFromAccountNames,
    toHex,
    twox128,
    utf8,
} from "./index.js";

describe("chain lookups", () => {
    test("twox128 matches Substrate prefixes", () => {
        expect(toHex(twox128(utf8("System")))).toBe("26aa394eea5630e07c48ae0c9558cef7");
        expect(toHex(twox128(utf8("Account")))).toBe("b99d880ec681799c0cf30e8886371da9");
        expect(toHex(twox128(utf8("Timestamp")))).toBe("f0c365c3cf59d671eb72da0e7a4113c4");
    });

    test("AccountNames key layout and value decoding", () => {
        const account = filled(32, 0x11);
        const key = accountNamesKey(account);
        expect(key.length).toBe(32 + 16 + 32);
        expect(toHex(key.subarray(48))).toBe(toHex(account));
        const chatKey = filled(32, 7);
        const value = AccountNamesCodec.enc({
            lite: { label: "alice.01", chat: chatKeyContainer(chatKey) },
            full: undefined,
        });
        const entry = decodeAccountNames(value);
        expect(entry.lite?.label).toBe("alice.01");
        expect(toHex(peerFromAccountNames(account, entry)?.chatKey ?? new Uint8Array())).toBe(
            toHex(chatKey),
        );
    });

    test("SS58 decode", () => {
        // Alice, generic substrate prefix 42.
        expect(
            toHex(
                decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY") ?? new Uint8Array(),
            ),
        ).toBe("d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d");
        expect(decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ")).toBeUndefined();
    });
});
