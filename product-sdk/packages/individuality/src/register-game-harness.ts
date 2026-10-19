// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Fixtures the game-registration tests share: an account, the personhood facts,
 * draw requirements, and capabilities with a recording `submit`.
 *
 * Imported only from in-source test blocks, so no published entry contains it.
 */
import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";
import { AccountId } from "polkadot-api";

import type { PersonhoodFacts } from "./bind-game-seat.js";
import type { DrawRequirement } from "./draw-entries.js";
import type {
    GameRegistrationCapabilities,
    SignUpSubmitOptions,
    SignUpSubmitResult,
    SubmitSignUp,
} from "./register-game-types.js";
import type { LiteSignUpBlocker } from "./signup-types.js";

export const ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
export const IDENTIFIER = new Uint8Array(65).fill(0x22);
export const PUBLIC_KEY = AccountId().enc(ADDRESS);
const RING = { chainId: "0x01" as const, junctions: [] };
export const FACTS: PersonhoodFacts = {
    derived: true,
    owner: "peopl.paseo",
    lite: { key: "lite", owner: "peopl.paseo", ring: RING },
    full: { key: "full", owner: "peopl.paseo", ring: RING },
};
export const EVENT_IDS = [`0x${"11".repeat(32)}`, `0x${"12".repeat(32)}`];
export const TICKET = { preOutput: new Uint8Array(32).fill(3), proof: new Uint8Array(64).fill(4) };

export const baseSigner = { publicKey: PUBLIC_KEY } as unknown as CommonSignerTxCreator;
export const tagged = (...tags: string[]) => tags.map((tag) => ({ tag }) as LiteSignUpBlocker);

export const drawRequirement = (overrides: Partial<DrawRequirement> = {}): DrawRequirement => ({
    variant: "Account",
    phase: "Registration",
    registrationEnds: 2_000,
    airdropsScheduled: 2,
    eventIds: EVENT_IDS,
    blockers: [],
    ...overrides,
});

/** A `submit` capability that records what it was handed and answers `result`. */
export const fakeSubmit = (result: SignUpSubmitResult = { ok: true }) => {
    const calls: {
        call: string;
        signer: CommonSignerTxCreator;
        options: SignUpSubmitOptions;
    }[] = [];
    const submit: SubmitSignUp = async (tx, signer, options) => {
        calls.push({ call: (tx as unknown as { call: string }).call, signer, options });
        options.onBroadcast?.();
        return result;
    };
    return { submit, calls };
};

export const capabilities = (
    extra: Partial<GameRegistrationCapabilities> = {},
): GameRegistrationCapabilities => ({
    account: { address: ADDRESS, publicKey: PUBLIC_KEY },
    signer: baseSigner,
    submit: fakeSubmit().submit,
    ...extra,
});
