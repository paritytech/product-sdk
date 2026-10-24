// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import {
    type AccountNamesEntry,
    type ChatKeysPort,
    type ChatProfile,
    type ChatSecrets,
    type Clock,
    chatKeyContainer,
    concat,
    type DeliveryPort,
    type DeliveryPreparation,
    type DirectoryPort,
    type PushPort,
    toHex,
    VecU8,
} from "../index.js";

import { LocalProver, type TestIdentity } from "./keys.js";

/** Shared stand-in for `DotnsGateway.AccountNames` and the username backend. */
export class StandInDirectory implements DirectoryPort {
    private readonly entries = new Map<
        string,
        { accountId: Uint8Array; entry: AccountNamesEntry }
    >();

    /** Registers a user's username and chat key, as a username claim does. */
    register(user: TestIdentity, username = user.label): void {
        this.entries.set(toHex(user.identity.account), {
            accountId: user.identity.account,
            entry: { lite: { label: username, chat: chatKeyContainer(user.chatPublicKey) } },
        });
    }

    async accountNames(accountId: Uint8Array): Promise<AccountNamesEntry | undefined> {
        return this.entries.get(toHex(accountId))?.entry;
    }
}

/** Stand-in for the host's `PersonChat` key services, over a test identity. */
export class StandInChatKeys implements ChatKeysPort {
    ownDevices: ChatProfile["ownDevices"];

    constructor(private readonly user: TestIdentity) {
        this.ownDevices = [
            {
                statementAccountId: user.identity.account,
                encryptionPublicKey: user.devicePublicKey,
                name: "phone",
            },
        ];
    }

    async profile(): Promise<ChatProfile> {
        return {
            identityAccountId: this.user.identity.account,
            chatPublicKey: this.user.chatPublicKey,
            liteUsername: this.user.label,
            role: "Primary",
            statementAccountId: this.user.identity.account,
            deviceEncPublicKey: this.user.devicePublicKey,
            ownDevices: this.ownDevices,
        };
    }

    async secrets(): Promise<ChatSecrets> {
        return {
            chatIdentitySecret: this.user.chatSecret,
            deviceEncSecret: this.user.deviceSecret,
        };
    }

    statementProver(): LocalProver {
        return this.user.identity;
    }

    async proveChatRequest(message: Uint8Array, acceptor: Uint8Array): Promise<Uint8Array> {
        return this.user.identity.sign(concat(message, VecU8.enc(acceptor)));
    }
}

/** Stand-in for anonymous request delivery: one fresh account per request and period, slots always free. */
export class StandInDelivery implements DeliveryPort {
    slotsAvailable = true;

    constructor(private readonly clock: Clock) {}

    currentPeriod(): number {
        return Math.floor(this.clock.nowMs() / 86_400_000);
    }

    async prepare(requestId: string): Promise<DeliveryPreparation> {
        if (!this.slotsAvailable) return { kind: "NoSlot" };
        const period = this.currentPeriod();
        return {
            kind: "Anonymous",
            period,
            prover: LocalProver.fromLabel(`chat-request//${requestId}//${period}`),
        };
    }
}

/** Records pushes a user sends. */
export class StandInPush implements PushPort {
    readonly sent: Parameters<PushPort["notifyPeer"]>[0][] = [];

    constructor(private readonly token?: Uint8Array) {}

    async ownToken() {
        return this.token ? { token: this.token, platform: 0 } : undefined;
    }

    async notifyPeer(request: Parameters<PushPort["notifyPeer"]>[0]): Promise<void> {
        this.sent.push(request);
    }
}
