// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Entry point for the @parity/product-sdk-statement-store E2E demo.
 *
 * Wires up SignerManager (for account discovery) + StatementStoreClient +
 * ChannelStore, exposing a minimal UI that the Playwright suite drives via
 * data-testid selectors.
 *
 * Flow inside the host-api-test-sdk test host:
 *   1. SignerManager.connect() auto-detects → HostProvider (product-sdk)
 *   2. Host responds with Bob's non-product account
 *   3. StatementStoreClient.connect() → createTransport() → HostTransport
 *      (host API's native binary protocol, not JSON-RPC)
 *   4. subscribe() → store.subscribe(topics, callback)
 *   5. publish() → store.createProof() + store.submit()
 */

import { SignerManager } from "@parity/product-sdk-signer";
import { StatementStoreClient, ChannelStore, createTopic, topicToHex } from "@parity/product-sdk-statement-store";

import { appendLog, getEl } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $accountAddress = getEl<HTMLSpanElement>("account-address");
const $storeStatus = getEl<HTMLSpanElement>("store-status");
const $publishInput = getEl<HTMLInputElement>("publish-input");
const $btnPublish = getEl<HTMLButtonElement>("btn-publish");
const $publishTopic2Input = getEl<HTMLInputElement>("publish-topic2-input");
const $btnPublishTopic2 = getEl<HTMLButtonElement>("btn-publish-topic2");
const $channelInput = getEl<HTMLInputElement>("channel-input");
const $btnChannelWrite = getEl<HTMLButtonElement>("btn-channel-write");
const $receivedCount = getEl<HTMLSpanElement>("received-count");
const $channelCount = getEl<HTMLSpanElement>("channel-count");
const $channelValue = getEl<HTMLSpanElement>("channel-value");
const $appTopicHex = getEl<HTMLSpanElement>("app-topic-hex");
const $log = getEl<HTMLElement>("statement-log");

function setControlsEnabled(enabled: boolean): void {
    $publishInput.disabled = !enabled;
    $btnPublish.disabled = !enabled;
    $publishTopic2Input.disabled = !enabled;
    $btnPublishTopic2.disabled = !enabled;
    $channelInput.disabled = !enabled;
    $btnChannelWrite.disabled = !enabled;
}

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($log, msg, level);
}

// ── App state ────────────────────────────────────────────────────────
const SS58_PREFIX = 0; // Paseo — addresses start with "1"
const APP_NAME = "statement-store-demo";

const manager = new SignerManager({ ss58Prefix: SS58_PREFIX, dappName: APP_NAME });
const client = new StatementStoreClient({ appName: APP_NAME });

// Expose the app topic hex for e2e tests — they need it to inject matching statements.
$appTopicHex.textContent = topicToHex(createTopic(APP_NAME));

interface ChannelValue {
    type: string;
    value: string;
    timestamp: number;
}

let channels: ChannelStore<ChannelValue> | null = null;
let receivedCount = 0;

// ── UI subscriptions ─────────────────────────────────────────────────
manager.subscribe((state) => {
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $accountAddress.textContent = state.selectedAccount?.address ?? "-";
});

// ── Actions ──────────────────────────────────────────────────────────
$btnPublish.addEventListener("click", async () => {
    const text = $publishInput.value || "hello";
    setControlsEnabled(false);
    log(`Publishing: "${text}"…`);

    try {
        const ok = await client.publish(
            { type: "test", text, timestamp: Date.now() },
        );
        if (ok) {
            log(`Published: "${text}"`, "ok");
        } else {
            log(`Publish rejected: "${text}"`, "err");
        }
    } catch (err) {
        log(`Publish failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnPublishTopic2.addEventListener("click", async () => {
    const text = $publishTopic2Input.value || "topic2 msg";
    setControlsEnabled(false);
    log(`Publishing with topic2: "${text}"…`);

    try {
        const ok = await client.publish(
            { type: "test", text, timestamp: Date.now() },
            { topic2: "e2e-room" },
        );
        if (ok) {
            log(`Published (topic2): "${text}"`, "ok");
        } else {
            log(`Publish (topic2) rejected: "${text}"`, "err");
        }
    } catch (err) {
        log(`Publish (topic2) failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

$btnChannelWrite.addEventListener("click", async () => {
    if (!channels) {
        log("ChannelStore not ready", "err");
        return;
    }
    const value = $channelInput.value || "presence";
    setControlsEnabled(false);
    log(`Writing channel "test-channel": "${value}"…`);

    try {
        const ok = await channels.write("test-channel", {
            type: "presence",
            value,
            timestamp: Date.now(),
        });
        if (ok) {
            log(`Channel write: "${value}"`, "ok");
        } else {
            log(`Channel write rejected: "${value}"`, "err");
        }
    } catch (err) {
        log(`Channel write failed: ${(err as Error).message}`, "err");
    } finally {
        setControlsEnabled(true);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
async function init() {
    log("Booting statement-store-demo…");

    // Step 1: connect signer (HostProvider inside the test host)
    log("Connecting signer…");
    const connectRes = await manager.connect();
    if (!connectRes.ok) {
        log(`Signer connect failed: ${connectRes.error.message}`, "err");
        return;
    }
    const accounts = connectRes.value;
    if (accounts.length === 0) {
        log("No accounts exposed by the host", "err");
        return;
    }
    const selectRes = manager.selectAccount(accounts[0].address);
    if (!selectRes.ok) {
        log(`selectAccount failed: ${selectRes.error.message}`, "err");
        return;
    }
    const address = accounts[0].address;
    log(`Signer ready: ${address}`, "ok");

    // Step 2: connect statement store (host mode)
    log("Connecting statement store…");
    try {
        await client.connect({ mode: "host", accountId: [address, SS58_PREFIX] });
        $storeStatus.textContent = "connected";
        log("Statement store connected (host transport)", "ok");
    } catch (err) {
        $storeStatus.textContent = "error";
        log(`Statement store connect failed: ${(err as Error).message}`, "err");
        return;
    }

    // Step 3: subscribe to all statements on this app's topic
    client.subscribe<Record<string, unknown>>((statement) => {
        receivedCount++;
        $receivedCount.textContent = String(receivedCount);
        const preview = JSON.stringify(statement.data).slice(0, 80);
        log(`Received #${receivedCount}: ${preview}`);
    });

    // Step 4: set up ChannelStore
    channels = new ChannelStore<ChannelValue>(client);
    channels.onChange((name, value) => {
        $channelCount.textContent = String(channels!.size);
        $channelValue.textContent = JSON.stringify(value);
        log(`Channel "${name}" updated: ${JSON.stringify(value)}`);
    });

    // Expose channels on window for e2e tests to write to arbitrary channel names.
    (window as unknown as Record<string, unknown>).__CHANNELS__ = channels;

    // Ready — enable controls
    setControlsEnabled(true);
    log("Ready", "ok");
}

init().catch((err) => log(`Unhandled init error: ${(err as Error).message}`, "err"));
