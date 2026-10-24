// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { fromHex, toHex } from "../bytes.js";
import { MinimalCandidatesCodec, MinimalSetupCodec } from "../wire/call.js";
import { decodeStrict } from "../wire/scale.js";

/** An ICE candidate as WebRTC gives it. */
export interface IceCandidate {
    sdp: string;
    sdpMLineIndex: number;
    sdpMid?: string;
}

/** The SDP of an offer or an answer, and the candidates sent with it. */
export interface CallSetup {
    sdp: string;
    candidates: IceCandidate[];
}

type MinimalCandidate = ReturnType<typeof MinimalCandidatesCodec.dec>[number];

const TRANSPORTS = ["TCP", "UDP"] as const;
const CANDIDATE_TYPES = ["host", "srflx", "relay", "prflx"] as const;
const SDP_TYPE_OFFER = 0;
const SDP_TYPE_ANSWER = 1;

/** Thrown for an SDP or a candidate the native data-channel profile cannot carry. */
export class SdpCodingError extends Error {}

function parseIpv4(text: string): Uint8Array | undefined {
    const parts = text.split(".");
    if (parts.length !== 4) return undefined;
    const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : 256));
    return bytes.every((byte) => byte <= 255) ? new Uint8Array(bytes) : undefined;
}

function parseIpv6(text: string): number[] | undefined {
    const halves = text.split("::");
    if (halves.length > 2) return undefined;
    const groups = (half: string) => (half === "" ? [] : half.split(":"));
    const head = groups(halves[0] ?? "");
    const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
    const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
    if (!all.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group))) return undefined;
    return all.map((group) => Number.parseInt(group, 16));
}

/** RFC 5952 text: lowercase, the longest run of two or more zero groups as `::`. */
function formatIpv6(groups: number[]): string {
    let bestStart = -1;
    let bestLength = 1;
    for (let start = 0; start < 8; start++) {
        let length = 0;
        while (start + length < 8 && groups[start + length] === 0) length++;
        if (length > bestLength) {
            bestStart = start;
            bestLength = length;
        }
    }
    const text = groups.map((group) => group.toString(16));
    if (bestStart < 0) return text.join(":");
    return `${text.slice(0, bestStart).join(":")}::${text.slice(bestStart + bestLength).join(":")}`;
}

/** Parses a candidate line as the native apps do (RFC 5245 tokens, component 1, data-channel m-line). */
export function parseCandidate(candidate: IceCandidate): MinimalCandidate {
    if (candidate.sdpMLineIndex !== 0)
        throw new SdpCodingError("only the data-channel m-line is carried");
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== "0")
        throw new SdpCodingError("only the data-channel mid is carried");
    const trimmed = candidate.sdp.trim();
    if (!trimmed.startsWith("candidate:")) throw new SdpCodingError("not a candidate line");
    const parts = trimmed
        .slice("candidate:".length)
        .split(" ")
        .filter((part) => part !== "");
    const [foundation, component, transport, priority, address, port, typ, type] = parts;
    if (parts.length < 8 || foundation === undefined || typ !== "typ")
        throw new SdpCodingError("malformed candidate");
    if (component !== "1") throw new SdpCodingError("only component 1 is carried");
    const transportIndex = TRANSPORTS.indexOf((transport ?? "").toUpperCase() as "TCP");
    const typeIndex = CANDIDATE_TYPES.indexOf((type ?? "").toLowerCase() as "host");
    const priorityValue = Number(priority);
    const portValue = Number(port);
    if (
        transportIndex < 0 ||
        typeIndex < 0 ||
        !Number.isInteger(priorityValue) ||
        priorityValue < 0 ||
        priorityValue > 0xffffffff ||
        !Number.isInteger(portValue) ||
        portValue < 0 ||
        portValue > 0xffff
    )
        throw new SdpCodingError("malformed candidate");
    const ipv4 = parseIpv4(address ?? "");
    const ipv6 = ipv4 ? undefined : parseIpv6(address ?? "");
    if (!ipv4 && !ipv6) throw new SdpCodingError("unsupported candidate address");
    return {
        foundation,
        priority: priorityValue,
        transport: transportIndex,
        address: ipv4 ? { tag: "Ipv4", value: ipv4 } : { tag: "Ipv6", value: ipv6 as number[] },
        port: portValue,
        type: typeIndex,
    };
}

function formatCandidate(candidate: MinimalCandidate): IceCandidate {
    const address =
        candidate.address.tag === "Ipv4"
            ? [...candidate.address.value].join(".")
            : formatIpv6(candidate.address.value);
    const params = [
        candidate.foundation,
        "1",
        TRANSPORTS[candidate.transport] ?? "UDP",
        String(candidate.priority),
        address,
        String(candidate.port),
        "typ",
        CANDIDATE_TYPES[candidate.type] ?? "host",
    ];
    return { sdp: `candidate:${params.join(" ")}`, sdpMLineIndex: 0, sdpMid: "0" };
}

function attribute(lines: string[], name: string): string | undefined {
    const prefix = `a=${name}:`;
    return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
}

/** `MinimalSetup` of an SDP and its candidates, as the native chat puts it in `DataChannelOffer`/`Answer` (A.16). */
export function encodeSetup(setup: CallSetup, nowMs: number): Uint8Array {
    const lines = setup.sdp.split(/\r?\n/).map((line) => line.trim());
    const iceUfrag = attribute(lines, "ice-ufrag");
    const icePwd = attribute(lines, "ice-pwd");
    const fingerprint = attribute(lines, "fingerprint");
    if (iceUfrag === undefined || icePwd === undefined || fingerprint === undefined)
        throw new SdpCodingError("the SDP has no ICE credentials or fingerprint");
    const hex = (
        fingerprint.includes(" ") ? fingerprint.slice(fingerprint.indexOf(" ") + 1) : fingerprint
    )
        .trim()
        .replaceAll(":", "");
    const origin = lines
        .find((line) => line.startsWith("o="))
        ?.slice(2)
        .split(" ")
        .filter(Boolean);
    const now = BigInt(Math.floor(nowMs / 1000));
    const sessionId = origin?.[1] !== undefined ? BigInt(origin[1]) : now;
    const sessionVersion = origin?.[2] !== undefined ? BigInt(origin[2]) : now;
    return MinimalSetupCodec.enc({
        sdpType:
            attribute(lines, "setup") === "actpass" || attribute(lines, "setup") === undefined
                ? SDP_TYPE_OFFER
                : SDP_TYPE_ANSWER,
        sessionId,
        sessionVersion,
        iceUfrag,
        icePwd,
        fingerprint: fromHex(hex),
        candidates: setup.candidates.map(parseCandidate),
    });
}

/** The SDP and candidates of a `MinimalSetup`, written as the native apps write them back. */
export function decodeSetup(bytes: Uint8Array): CallSetup {
    const setup = decodeStrict(MinimalSetupCodec, bytes);
    const fingerprint = toHex(setup.fingerprint).toUpperCase().match(/../g)?.join(":");
    const sdp = [
        "v=0",
        `o=- ${setup.sessionId} ${setup.sessionVersion} IN IP4 0.0.0.0`,
        "s=-",
        "t=0 0",
        "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
        "c=IN IP4 0.0.0.0",
        `a=ice-ufrag:${setup.iceUfrag}`,
        `a=ice-pwd:${setup.icePwd}`,
        `a=fingerprint:sha-256 ${fingerprint ?? ""}`,
        `a=setup:${setup.sdpType === SDP_TYPE_OFFER ? "actpass" : "active"}`,
        "a=mid:0",
        "a=sctp-port:5000",
        "",
    ].join("\n");
    return { sdp, candidates: setup.candidates.map(formatCandidate) };
}

/** The `Vec<MinimalCandidate>` of `DataChannelIceCandidate`. */
export function encodeCandidates(candidates: IceCandidate[]): Uint8Array {
    return MinimalCandidatesCodec.enc(candidates.map(parseCandidate));
}

/** The candidates of a `DataChannelIceCandidate`. */
export function decodeCandidates(bytes: Uint8Array): IceCandidate[] {
    return decodeStrict(MinimalCandidatesCodec, bytes).map(formatCandidate);
}
