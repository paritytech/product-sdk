// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * The worker the manifest's `entrypoint` points at.
 *
 * `defineChatWorker` runs at the top level, before any `await`, so the handlers
 * of the host's queries exist before its first one arrives; until `start`
 * resolves, every query is answered "unavailable" and the host asks again. The
 * store is scoped to the signed-in identity, and the worker starts again on a
 * sign-out or an account switch.
 */
import { JournaledRoomMessageStore, defineChatWorker, sessionScope } from "@parity/product-sdk-chat";
import { getNotificationManager } from "@parity/product-sdk-host";
import { getHostByteStore, openJournaledStore } from "@parity/product-sdk-local-storage";

import { startDemo } from "./demo.js";

const worker = defineChatWorker({
    async start({ client }) {
        const scope = await sessionScope("chat-room-demo/data/v1");
        const kv = await getHostByteStore();
        if (!scope.ok || !kv) throw new Error("the host gives no storage");
        const store = await JournaledRoomMessageStore.open(
            await openJournaledStore(kv, `chat-room-demo/${scope.value}`),
        );
        const notifications = await getNotificationManager();
        return startDemo({ client, store, ...(notifications ? { notifications } : {}) });
    },
});

if (!worker) console.log("no host container: the chat demo runs only inside a host");
