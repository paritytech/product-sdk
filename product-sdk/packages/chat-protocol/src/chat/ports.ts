// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { StatementProver } from "../ports.js";
import type { PeerDevice } from "../transport/lanes.js";

/** One of the user's own devices, for `DeviceAdded` fan-out. */
export interface OwnDevice extends PeerDevice {
    name: string;
}

/** The user's chat identity as the host's `PersonChat.getProfile` describes it. */
export interface ChatProfile {
    identityAccountId: Uint8Array;
    chatPublicKey: Uint8Array;
    liteUsername?: string;
    fullUsername?: string;
    /** Primary on the wallet (statement account = identity account); Linked on a paired host. */
    role: "Primary" | "Linked";
    statementAccountId: Uint8Array;
    deviceEncPublicKey: Uint8Array;
    ownDevices: OwnDevice[];
}

/** X25519 secrets the trusted chat product may hold (decision 1). */
export interface ChatSecrets {
    chatIdentitySecret: Uint8Array;
    deviceEncSecret: Uint8Array;
}

/** The host's `PersonChat` key services. */
export interface ChatKeysPort {
    profile(): Promise<ChatProfile>;
    secrets(): Promise<ChatSecrets>;
    /** Signs statements as the profile's statement account. */
    statementProver(): StatementProver;
    /** sr25519 signature by the identity account over `SCALE(ChatRequestMessage) ‖ compact(32) ‖ acceptor`. */
    proveChatRequest(message: Uint8Array, acceptor: Uint8Array): Promise<Uint8Array>;
}

/** Anonymous delivery of a chat request (host `PersonChat.prepareDelivery`). */
export type DeliveryPreparation =
    | { kind: "Anonymous"; period: number; prover: StatementProver }
    | { kind: "NoSlot" };

/** The host's chat-request delivery accounts and notification slots. */
export interface DeliveryPort {
    prepare(requestId: string, size: number): Promise<DeliveryPreparation>;
    /** Current delivery period, for renewal. */
    currentPeriod(): number;
}

/** One side of an `AccountNames` record: a username label and an optional 65-byte chat key container. */
export interface AccountName {
    label: string;
    chat?: Uint8Array;
}

/** `DotnsGateway.AccountNames` entry on Asset Hub. */
export interface AccountNamesEntry {
    lite?: AccountName;
    full?: AccountName;
}

/** On-chain lookups of usernames and chat keys. */
export interface DirectoryPort {
    accountNames(accountId: Uint8Array): Promise<AccountNamesEntry | undefined>;
}

/** The host's push services (`PersonChat` push methods). */
export interface PushPort {
    ownToken(): Promise<{ token: Uint8Array; platform: number } | undefined>;
    /** The PushKit VoIP token of this device, on iOS. */
    ownVoipToken?(): Promise<Uint8Array | undefined>;
    notifyPeer(request: {
        deviceToken: string;
        pushId: Uint8Array;
        platform: "android" | "ios";
        message: Uint8Array;
        voip: boolean;
    }): Promise<void>;
}

/** A HOP pool entry as a chat message names it: its identifier, the ticket that opens and claims it, and its node. */
export interface HopReference {
    identifier: Uint8Array;
    ticket: Uint8Array;
    node: string;
}

/** A downloaded file and the pool entries to ack once it is kept. */
export interface HopDownload {
    data: Uint8Array;
    entries: Uint8Array[];
}

/**
 * The host's HOP client (`PersonChat` HOP calls, HC3). The host makes the
 * ticket, seals the entries, signs the submit with its Bulletin allowance
 * account and talks to the node; the product only keeps references.
 */
export interface HopPort {
    /** Stores `data` as one file on a node the host picks. */
    uploadBlob(data: Uint8Array): Promise<HopReference>;
    /** Claims and opens a file, falling back to Bulletin for entries the node no longer holds. */
    downloadBlob(reference: HopReference): Promise<HopDownload>;
    /** Tells the node the entries of a download were taken, after what they carried is stored. */
    ack(reference: HopReference, entries: Uint8Array[]): Promise<void>;
}
