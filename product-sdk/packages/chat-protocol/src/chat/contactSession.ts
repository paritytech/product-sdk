// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { Clock, IdSource, Logger, StatementProver, StatementsPort } from "../ports.js";
import { MultiDeviceLane, PairwiseLane, type PeerDevice } from "../transport/lanes.js";
import {
    CommunicationSession,
    type Compactor,
    type SessionListener,
} from "../transport/session.js";
import { CONTACT_MAX_STATEMENT_BYTES } from "../transport/sessionState.js";
import type { TopicSubscriptions } from "../transport/statements.js";
import type { ChatProfile, ChatSecrets } from "./ports.js";

/** Session lane a message travels on: the main (multi-device) lane or the identity lane. */
export type MessageLane = "Main" | "Identity";

/** What a contact session needs of a contact: who it is, its chat key and its devices. */
export interface SessionContact {
    /** Hex of the identity account. */
    id: string;
    accountId: Uint8Array;
    /** The contact's identity chat key (X25519 public). */
    chatKey: Uint8Array;
    devices: PeerDevice[];
}

/** Shared dependencies of every contact session. */
export interface ContactSessionDeps {
    statements: StatementsPort;
    subscriptions: TopicSubscriptions;
    prover: StatementProver;
    clock: Clock;
    ids: IdSource;
    logger: Logger;
    profile: ChatProfile;
    secrets: ChatSecrets;
    maxStatementBytes?: number;
    compactor?: Compactor;
}

/**
 * The sessions of one contact (`RealContactChatSession`): Pairwise when we
 * know none of the peer's devices, otherwise a MultiDevice main session plus
 * the Pairwise identity session.
 */
export class ContactSession {
    readonly mode: "Pairwise" | "MultiDevice";
    private readonly main: CommunicationSession;
    private readonly identity: CommunicationSession | undefined;

    constructor(
        deps: ContactSessionDeps,
        private contact: SessionContact,
        listenerFor: (lane: MessageLane) => SessionListener,
    ) {
        this.mode = contact.devices.length > 0 ? "MultiDevice" : "Pairwise";
        const base = {
            owner: contact.id,
            statements: deps.statements,
            subscriptions: deps.subscriptions,
            prover: deps.prover,
            clock: deps.clock,
            ids: deps.ids,
            logger: deps.logger,
            maxStatementBytes: deps.maxStatementBytes ?? CONTACT_MAX_STATEMENT_BYTES,
        };
        const pairwiseLane = new PairwiseLane({
            localAccount: deps.profile.identityAccountId,
            remoteAccount: contact.accountId,
            chatSecret: deps.secrets.chatIdentitySecret,
            peerChatKey: contact.chatKey,
            extraSigners: () => this.contact.devices.map((device) => device.statementAccountId),
            onUnexpectedSigner: () =>
                deps.logger.warn("identity-lane statement from a signer outside the roster"),
        });
        if (this.mode === "Pairwise") {
            this.main = new CommunicationSession({
                ...base,
                lane: pairwiseLane,
                ...(deps.compactor ? { compactor: deps.compactor } : {}),
                listener: listenerFor("Main"),
            });
            this.identity = undefined;
        } else {
            this.main = new CommunicationSession({
                ...base,
                lane: new MultiDeviceLane({
                    statementAccount: deps.profile.statementAccountId,
                    identityAccount: deps.profile.identityAccountId,
                    remoteAccount: contact.accountId,
                    chatSecret: deps.secrets.chatIdentitySecret,
                    deviceSecret: deps.secrets.deviceEncSecret,
                    peerChatKey: contact.chatKey,
                    roster: () => this.contact.devices,
                }),
                ...(deps.compactor ? { compactor: deps.compactor } : {}),
                listener: listenerFor("Main"),
            });
            this.identity = new CommunicationSession({
                ...base,
                lane: pairwiseLane,
                listener: listenerFor("Identity"),
            });
        }
    }

    async start(): Promise<void> {
        await this.main.start();
        await this.identity?.start();
    }

    stop(): void {
        this.main.stop();
        this.identity?.stop();
    }

    /** Sends an encoded message on its lane. In Pairwise mode both lanes are the same session. */
    submit(message: Uint8Array, lane: MessageLane): Promise<void> {
        return (lane === "Identity" && this.identity ? this.identity : this.main).submit(message);
    }

    /** Lanes that exist as separate sessions. */
    lanes(): MessageLane[] {
        return this.identity ? ["Main", "Identity"] : ["Main"];
    }

    /** Updates the contact the lanes read their roster from. */
    updateContact(contact: SessionContact): void {
        this.contact = contact;
    }

    idle(): Promise<void> {
        return Promise.all([this.main.idle(), this.identity?.idle()]).then(() => undefined);
    }
}
