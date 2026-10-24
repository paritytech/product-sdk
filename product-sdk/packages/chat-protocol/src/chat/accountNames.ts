// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { blake2bHash } from "@parity/product-sdk-crypto/hashing";
import { Option, Struct, str } from "scale-ts";

import { concat, utf8 } from "../bytes.js";
import { twox128 } from "../crypto/twox.js";
import { decodeLenient, Fixed } from "../wire/scale.js";
import type { AccountNamesEntry } from "./ports.js";

const AccountNameCodec = Struct({ label: str, chat: Option(Fixed(65)) });

/** `DotnsGateway.AccountNames` value: `{ lite: Option<{label, chat}>, full: Option<{label, chat}> }`. */
export const AccountNamesCodec = Struct({
    lite: Option(AccountNameCodec),
    full: Option(AccountNameCodec),
});

/** Storage key of `DotnsGateway.AccountNames[account]` (Blake2_128Concat, as the core keys the pallet's maps). */
export function accountNamesKey(account: Uint8Array): Uint8Array {
    return concat(
        twox128(utf8("DotnsGateway")),
        twox128(utf8("AccountNames")),
        blake2bHash(account, { length: 16 }),
        account,
    );
}

/** Decodes an `AccountNames` value. */
export function decodeAccountNames(value: Uint8Array): AccountNamesEntry {
    const decoded = decodeLenient(AccountNamesCodec, value);
    const side = (name: { label: string; chat: Uint8Array | undefined } | undefined) =>
        name ? { label: name.label, ...(name.chat ? { chat: name.chat } : {}) } : undefined;
    const lite = side(decoded.lite);
    const full = side(decoded.full);
    return { ...(lite ? { lite } : {}), ...(full ? { full } : {}) };
}
