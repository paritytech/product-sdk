// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
export { ATTESTATION_SERVICE_ABI, SCHEMA_REGISTRY_ABI } from "./abi.js";
export {
    createAttestationClient,
    MAX_ATTESTATION_READ_IDS,
    type Attestation,
    type AttestationClient,
    type AttestationClientOptions,
    type AttestationPrepareOptions,
    type AttestationRequest,
    type AttestationSchema,
    type H160,
    type RevocationRequest,
} from "./attestations.js";
export { readAttestedEvents, type AttestedEvent } from "./events.js";
export {
    ReputationDecodeError,
    ReputationError,
    ReputationInputError,
    ReputationQueryError,
} from "./errors.js";
export {
    readHonourTally,
    type HonourChain,
    type HonourSnapshot,
    type HonourTally,
    type ReadHonourTallyOptions,
    type SubjectId,
} from "./honour.js";
