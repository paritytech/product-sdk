// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { Enum, Struct, str, u8, Vector } from "scale-ts";

import { Bytes32, VecU8 } from "./scale.js";

/** A batch of encoded chat messages under one request id. */
export const RequestCodec = Struct({ requestId: str, messages: Vector(VecU8) });

/** Acknowledgement of a request. `responseCode` is 0 for success. */
export const ResponseCodec = Struct({ requestId: str, responseCode: u8 });

/** One recipient device's wrapped payload key in a multi-device envelope. */
export const RequestDeviceInfoCodec = Struct({ statementAccountId: Bytes32, encryptedKey: VecU8 });

/**
 * `StructuredStatementData` (Appendix A.7). The plain variants are encrypted
 * as a whole; the multi variants carry an inner Request or Response encoded
 * **without** its variant byte (`RequestCodec`/`ResponseCodec` alone).
 */
export const StatementDataCodec = Enum(
    {
        Request: RequestCodec,
        Response: ResponseCodec,
        MultiRequest: Struct({
            encryptedRequest: VecU8,
            devicesInfo: Vector(RequestDeviceInfoCodec),
        }),
        MultiResponse: Struct({
            encryptedResponse: VecU8,
            devicesInfo: Vector(RequestDeviceInfoCodec),
        }),
    },
    [0, 1, 2, 3],
);

/** Decoded `StructuredStatementData`. */
export type StatementData = ReturnType<typeof StatementDataCodec.dec>;

/** A request: an id and the encoded messages it carries. */
export type RequestFrame = ReturnType<typeof RequestCodec.dec>;

/** A response: the acknowledged request id and its code. */
export type ResponseFrame = ReturnType<typeof ResponseCodec.dec>;

/** Response code of a successful acknowledgement. */
export const PROTOCOL_ACK_CODE = 0;
