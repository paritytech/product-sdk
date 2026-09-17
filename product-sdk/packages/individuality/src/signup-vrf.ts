// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Merlin transcript an `AirdropVrfs::Account` entry signs, mirroring
 * `indiv_pallet_airdrop::vrf::transcript_for_event`:
 *
 * ```
 * label          = "pop:airdrop"
 * item "domain"  = "pop:airdrop" ‖ event_id(32)
 * item "signer"  = sr25519 public key(32)
 * ```
 *
 * Neither constant reaches metadata, unlike `Game`'s event-id base, so the pinned
 * vectors below are the only guard.
 *
 * Two bindings that are easy to get wrong. `signer` must be the account that signs
 * the sign-up, since the pallet reinterprets the account id *as* the public key.
 * And entry `i` binds to airdrop index `i`, where one mismatch fails the whole
 * sign-up, deposit included.
 *
 * No workspace package is imported here, so these tests run against an unbuilt tree.
 */
import { ProductIndividualityError } from "./errors.js";

/** `VRF_TRANSCRIPT_LABEL`, which is also the domain item's prefix. */
export const AIRDROP_VRF_TRANSCRIPT_LABEL = "pop:airdrop";

/** Merlin `append_message(label, value)`, as the host's `signVrf` takes it. */
export interface VrfTranscriptItem {
    label: Uint8Array;
    value: Uint8Array;
}

export interface VrfTranscript {
    label: Uint8Array;
    /** `domain` then `signer`. The order is part of the message. */
    items: VrfTranscriptItem[];
}

const EVENT_ID_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 32 bytes from `0x` hex or raw bytes. Anything else is a caller error. */
function eventIdBytes(eventId: string | Uint8Array): Uint8Array {
    if (eventId instanceof Uint8Array) {
        return sized(eventId, EVENT_ID_BYTES, "event id");
    }
    if (!eventId.startsWith("0x")) {
        throw new ProductIndividualityError("airdrop event id must be 0x-prefixed hex");
    }
    const digits = eventId.slice(2);
    if (digits.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(digits)) {
        throw new ProductIndividualityError("airdrop event id is not valid hex");
    }
    const bytes = new Uint8Array(digits.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    }
    return sized(bytes, EVENT_ID_BYTES, "event id");
}

function sized(bytes: Uint8Array, length: number, what: string): Uint8Array {
    if (bytes.length !== length) {
        throw new ProductIndividualityError(`airdrop VRF ${what} must be ${length} bytes`);
    }
    return bytes;
}

/**
 * `domain_for_event`: label bytes then the event id. Exported as the one part
 * worth checking against a chain-side value.
 */
export function airdropVrfDomain(eventId: string | Uint8Array): Uint8Array {
    const label = ascii(AIRDROP_VRF_TRANSCRIPT_LABEL);
    const id = eventIdBytes(eventId);
    const domain = new Uint8Array(label.length + id.length);
    domain.set(label, 0);
    domain.set(id, label.length);
    return domain;
}

/**
 * The transcript for one draw.
 *
 * @param options.publicKey - 32 bytes. The scheme is not checkable here, so an
 *   ed25519 account yields a well-formed transcript and an unverifiable VRF.
 * @throws ProductIndividualityError on a malformed event id or a wrong-width key.
 */
export function airdropVrfTranscript(options: {
    eventId: string | Uint8Array;
    publicKey: Uint8Array;
}): VrfTranscript {
    return {
        label: ascii(AIRDROP_VRF_TRANSCRIPT_LABEL),
        items: [
            { label: ascii("domain"), value: airdropVrfDomain(options.eventId) },
            {
                label: ascii("signer"),
                // Copied: the other two items allocate, so this is the only path
                // where a caller mutating its buffer would change the transcript.
                value: Uint8Array.from(sized(options.publicKey, PUBLIC_KEY_BYTES, "signer key")),
            },
        ],
    };
}

if (import.meta.vitest) {
    const { describe, expect, test } = import.meta.vitest;

    /** Hand-rolled: a vector sharing an encoder with the code under test pins nothing. */
    const hex = (bytes: Uint8Array): string =>
        [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

    const EVENT_ID = `0x${"ab".repeat(32)}`;
    const KEY = new Uint8Array(32).fill(0x11);

    describe("the pinned label", () => {
        test("is the pallet's VRF_TRANSCRIPT_LABEL, 11 bytes", () => {
            expect(AIRDROP_VRF_TRANSCRIPT_LABEL).toBe("pop:airdrop");
            expect(new TextEncoder().encode(AIRDROP_VRF_TRANSCRIPT_LABEL)).toHaveLength(11);
        });
    });

    describe("airdropVrfDomain", () => {
        test("is the label followed by the event id, 43 bytes", () => {
            const domain = airdropVrfDomain(EVENT_ID);
            expect(domain).toHaveLength(43);
            expect(hex(domain)).toBe(
                `${hex(new TextEncoder().encode("pop:airdrop"))}${"ab".repeat(32)}`,
            );
        });

        test("takes raw bytes identically to hex", () => {
            const bytes = new Uint8Array(32).fill(0xab);
            expect(hex(airdropVrfDomain(bytes))).toBe(hex(airdropVrfDomain(EVENT_ID)));
        });

        test("rejects an event id of the wrong width", () => {
            // 31 bytes still makes a plausible-looking domain, addressing no draw.
            expect(() => airdropVrfDomain(`0x${"ab".repeat(31)}`)).toThrow(
                ProductIndividualityError,
            );
        });

        test("rejects an unprefixed or malformed id", () => {
            expect(() => airdropVrfDomain("ab".repeat(32))).toThrow(ProductIndividualityError);
            expect(() => airdropVrfDomain(`0x${"zz".repeat(32)}`)).toThrow(
                ProductIndividualityError,
            );
        });
    });

    describe("airdropVrfTranscript", () => {
        test("binds domain then signer, in that order", () => {
            const transcript = airdropVrfTranscript({ eventId: EVENT_ID, publicKey: KEY });

            expect(new TextDecoder().decode(transcript.label)).toBe("pop:airdrop");
            expect(transcript.items.map((item) => new TextDecoder().decode(item.label))).toEqual([
                "domain",
                "signer",
            ]);
            expect(hex(transcript.items[0].value)).toBe(hex(airdropVrfDomain(EVENT_ID)));
            expect(hex(transcript.items[1].value)).toBe("11".repeat(32));
        });

        test("gives two events different domains and the same signer", () => {
            const a = airdropVrfTranscript({ eventId: `0x${"01".repeat(32)}`, publicKey: KEY });
            const b = airdropVrfTranscript({ eventId: `0x${"02".repeat(32)}`, publicKey: KEY });

            expect(hex(a.items[0].value)).not.toBe(hex(b.items[0].value));
            expect(hex(a.items[1].value)).toBe(hex(b.items[1].value));
        });

        test("rejects a key that is not 32 bytes", () => {
            // A 33-byte ecdsa key is the realistic way to reach this.
            expect(() =>
                airdropVrfTranscript({ eventId: EVENT_ID, publicKey: new Uint8Array(33) }),
            ).toThrow(ProductIndividualityError);
        });
    });
}
