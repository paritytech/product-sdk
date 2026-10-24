// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import {
    decodeCandidates,
    decodeSetup,
    encodeCandidates,
    encodeSetup,
    MinimalSetupCodec,
    parseCandidate,
    SdpCodingError,
} from "./index.js";

// The setup of the Android SdpCoder test, which both apps decode to this text.
const SDP = [
    "v=0",
    "o=- 12345 67890 IN IP4 0.0.0.0",
    "s=-",
    "t=0 0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=ice-ufrag:ufrag123",
    "a=ice-pwd:pwd123",
    "a=fingerprint:sha-256 A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6:A1:B2:C3:D4:E5:F6",
    "a=setup:actpass",
    "a=mid:0",
    "a=sctp-port:5000",
    "",
].join("\n");

describe("SDP coder of the native data-channel profile (A.16)", () => {
    test("a setup comes back as the native apps write it, candidates in their spelling", () => {
        const encoded = encodeSetup(
            {
                sdp: SDP,
                candidates: [
                    {
                        sdp: "candidate:1 1 udp 2122260223 192.168.1.1 1234 typ host",
                        sdpMLineIndex: 0,
                        sdpMid: "0",
                    },
                ],
            },
            0,
        );
        const minimal = MinimalSetupCodec.dec(encoded);
        expect(minimal.sdpType).toBe(0);
        expect(BigInt(minimal.sessionId)).toBe(12345n);
        expect(minimal.fingerprint.length).toBe(30);

        const decoded = decodeSetup(encoded);
        expect(decoded.sdp).toBe(SDP);
        expect(decoded.candidates).toEqual([
            {
                sdp: "candidate:1 1 UDP 2122260223 192.168.1.1 1234 typ host",
                sdpMLineIndex: 0,
                sdpMid: "0",
            },
        ]);
    });

    test("an answer, a browser SDP with CRLF and more lines, keeps only what the profile carries", () => {
        const browser = [
            "v=0",
            "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
            "s=-",
            "t=0 0",
            "a=group:BUNDLE 0",
            "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
            "c=IN IP4 0.0.0.0",
            "a=ice-ufrag:Ab1c",
            "a=ice-pwd:xYz0123456789abcdefghij",
            "a=ice-options:trickle",
            "a=fingerprint:sha-256 0A:0B",
            "a=setup:active",
            "a=mid:0",
            "a=sctp-port:5000",
            "",
        ].join("\r\n");
        const decoded = decodeSetup(encodeSetup({ sdp: browser, candidates: [] }, 0));
        expect(decoded.sdp).toContain("a=setup:active\n");
        expect(decoded.sdp).toContain("o=- 4611731400430051336 2 IN IP4 0.0.0.0\n");
        expect(decoded.sdp).toContain("a=fingerprint:sha-256 0A:0B\n");
    });

    test("candidate lists round trip, IPv6 in its short form", () => {
        const candidates = [
            { sdp: "candidate:2 1 tcp 123456 10.0.0.1 5678 typ srflx", sdpMLineIndex: 0 },
            { sdp: "candidate:3 1 udp 7 2001:db8:0:0:0:0:0:1 9 typ relay", sdpMLineIndex: 0 },
        ];
        expect(
            decodeCandidates(encodeCandidates(candidates)).map((candidate) => candidate.sdp),
        ).toEqual([
            "candidate:2 1 TCP 123456 10.0.0.1 5678 typ srflx",
            "candidate:3 1 UDP 7 2001:db8::1 9 typ relay",
        ]);
    });

    test("what the profile cannot carry is refused, as by the native coders", () => {
        expect(() =>
            parseCandidate({ sdp: "candidate:1 2 udp 1 1.2.3.4 5 typ host", sdpMLineIndex: 0 }),
        ).toThrow(SdpCodingError);
        expect(() =>
            parseCandidate({ sdp: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMLineIndex: 1 }),
        ).toThrow(SdpCodingError);
        expect(() =>
            parseCandidate({ sdp: "candidate:1 1 udp 1 host.local 5 typ host", sdpMLineIndex: 0 }),
        ).toThrow(SdpCodingError);
        expect(() => encodeSetup({ sdp: "v=0\n", candidates: [] }, 0)).toThrow(SdpCodingError);
    });
});
