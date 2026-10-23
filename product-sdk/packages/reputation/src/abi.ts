// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import { parseAbi } from "viem";

export const ATTESTATION_SERVICE_ABI = parseAbi([
    "function attest((uint256 schema,(address recipient,uint64 expirationTime,bool revocable,uint256 refId,bytes data) data) request) returns (uint256)",
    "function revoke((uint256 schema,(uint256 id) data) request)",
    "function getAttestationById(uint256 id) view returns ((uint256 id,uint256 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,uint256 refId,address recipient,address attester,bool revocable,bytes data))",
    "function getAttestationByIds(uint256[] ids) view returns ((uint256 id,uint256 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,uint256 refId,address recipient,address attester,bool revocable,bytes data)[])",
    "function isActive(uint256 id) view returns (bool)",
    "event Attested(address indexed recipient,address indexed attester,uint256 indexed schema,uint256 id)",
]);

export const SCHEMA_REGISTRY_ABI = parseAbi([
    "function getSchema(uint256 id) view returns ((uint256 id,address registerer,address resolver,bool revocable,bool unique,string schema))",
]);
