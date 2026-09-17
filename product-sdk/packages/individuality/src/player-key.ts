// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The `AccountOrPerson` key the game and score reads take, and the one place
 * an {@link AirdropRegistrant} is turned into it.
 *
 * Two things keep the umbrella contract test honest here, both verified by
 * breaking them. The narrow type catches a descriptor re-pin that renames an arm.
 * Property syntax on the `getValue`s that take it catches widening this back to
 * `{ type: string }`, which method syntax would accept, since method parameters
 * are bivariant. Without either, a renamed arm reads nothing and looks like an
 * absent record.
 */
import { Enum } from "polkadot-api";
import type { AirdropRegistrant } from "./airdrop-types.js";

export type PlayerKey = { type: "Account"; value: string } | { type: "Person"; value: string };

export function playerKey(registrant: AirdropRegistrant): PlayerKey {
    // `AccountOrPerson` spells the alias arm `Person` where the airdrop pallet's
    // registration entry spells it `Alias`. Same identity, two names, and the
    // wrong one reads nothing rather than failing.
    return registrant.tag === "Account"
        ? Enum("Account", registrant.accountAddress)
        : Enum("Person", registrant.alias);
}
