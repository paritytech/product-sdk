// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { _void, bool, compact, Enum, Option, Struct, str, u8, u16, u32, Vector } from "scale-ts";

import { Fixed, VecU8 } from "./scale.js";

/** Compressed ICE candidate (Appendix A.16.2). Android declares `priority` as i32; the bytes are the same. */
export const MinimalCandidateCodec = Struct({
    foundation: str,
    priority: u32,
    transport: u8,
    address: Enum({ Ipv4: Fixed(4), Ipv6: Vector(u16, 8) }, [0, 1]),
    port: u16,
    type: u8,
});

/** Compressed data-channel SDP carried in `DataChannelOffer` and `DataChannelAnswer`. */
export const MinimalSetupCodec = Struct({
    sdpType: u8,
    sessionId: compact,
    sessionVersion: compact,
    iceUfrag: str,
    icePwd: str,
    fingerprint: VecU8,
    candidates: Vector(MinimalCandidateCodec),
});

/** Candidates of `DataChannelIceCandidate.sdp`. */
export const MinimalCandidatesCodec = Vector(MinimalCandidateCodec);

/** Frame multiplexed on a call or sync data channel. */
export const DataChannelMessageCodec = Struct({ id: str, data: VecU8 });

/** In-band renegotiation signal. `Closed` is sent by iOS only. */
export const PeerConnectionSignalCodec = Enum(
    {
        Offer: str,
        Answer: str,
        IceCandidates: Vector(Struct({ sdp: str, sdpMLineIndex: u32, sdpMid: Option(str) })),
        Closed: _void,
    },
    [0, 1, 2, 3],
);

/** Camera and microphone state signal. */
export const MediaStateSignalCodec = Enum({ CameraEnabled: bool, MicrophoneEnabled: bool }, [0, 1]);
