/**
 * Entry point for the @parity/product-sdk-signer E2E demo.
 *
 * Drives `SignerManager` through the Host API path — the same path
 * production apps take inside Polkadot Desktop / Mobile. Every user-visible
 * action is exposed as a `data-testid`'d control so the Playwright suite
 * can drive it against the `@parity/host-api-test-sdk` test host.
 *
 * Flow inside the test host:
 *   1. SignerManager.connect() auto-detects → HostProvider (product-sdk)
 *   2. HostProvider also auto-requests the host's TransactionSubmit
 *      permission (introduced in signer 1.0.2 — required for signRaw /
 *      signPayload to succeed against the production host).
 *   3. UI renders accounts → click to select → signRaw bytes → see hex
 *      signature. Disconnect/reconnect buttons exercise the lifecycle.
 */

import { SignerManager } from "@parity/product-sdk-signer";
import type { SignerState } from "@parity/product-sdk-signer";

import { appendLog, getEl, toHex } from "./ui.js";

// ── DOM ───────────────────────────────────────────────────────────────
const $connectionStatus = getEl<HTMLSpanElement>("connection-status");
const $activeProvider = getEl<HTMLSpanElement>("active-provider");
const $selectedAddress = getEl<HTMLSpanElement>("selected-address");
const $accountsList = getEl<HTMLElement>("accounts-list");
const $rawInput = getEl<HTMLInputElement>("raw-input");
const $btnSignRaw = getEl<HTMLButtonElement>("btn-sign-raw");
const $btnConnect = getEl<HTMLButtonElement>("btn-connect");
const $btnDisconnect = getEl<HTMLButtonElement>("btn-disconnect");
const $btnReconnect = getEl<HTMLButtonElement>("btn-reconnect");
const $lastSignature = getEl<HTMLElement>("last-signature");
const $lastError = getEl<HTMLElement>("last-error");
const $eventLog = getEl<HTMLElement>("event-log");
const $dotnsInput = getEl<HTMLInputElement>("dotns-input");
const $btnGetProductAccount = getEl<HTMLButtonElement>("btn-get-product-account");
const $productAccountAddress = getEl<HTMLElement>("product-account-address");
const $subscribeCount = getEl<HTMLSpanElement>("subscribe-count");
const $transitionCount = getEl<HTMLSpanElement>("transition-count");
const $onconnectCount = getEl<HTMLSpanElement>("onconnect-count");
const $transitionsList = getEl<HTMLElement>("transitions-list");
const $onConnectStatus = getEl<HTMLSpanElement>("onconnect-status");
const $onConnectResult = getEl<HTMLElement>("onconnect-result");

function log(msg: string, level: Parameters<typeof appendLog>[2] = "info"): void {
    appendLog($eventLog, msg, level);
}

// ── State ─────────────────────────────────────────────────────────────
// Paseo Asset Hub uses SS58 prefix 0 → addresses start with "1".
const SS58_PREFIX = 0;

// `onConnect` fires once per status flip into "connected" — not on the
// many other state mutations (selectAccount, account-list updates, etc.)
// that happen while already connected. Re-fires after auto-reconnect, and
// the `ctx.signal` aborts if the user disconnects or destroys the manager
// while the callback is in flight.
//
// We track a counter so the e2e suite can assert single-fire-per-session
// — the contract is documented on SignerManagerOptions.onConnect; the
// demo proves it visibly.
let onConnectFiredCount = 0;
let subscribeFiredCount = 0;
let statusTransitionCount = 0;
let prevStatus: SignerState["status"] | null = null;

function recordTransition(from: SignerState["status"] | null, to: SignerState["status"]): void {
    statusTransitionCount += 1;
    $transitionCount.textContent = String(statusTransitionCount);
    const row = document.createElement("div");
    row.className = "transition-row";
    row.dataset.testid = "transition-row";
    row.textContent = `${from ?? "(init)"} → ${to}`;
    $transitionsList.appendChild(row);
}

const manager = new SignerManager({
    ss58Prefix: SS58_PREFIX,
    dappName: "signer-demo",
    onConnect: async (account, { requestResourceAllocation, signal }) => {
        onConnectFiredCount += 1;
        $onconnectCount.textContent = String(onConnectFiredCount);
        $onConnectStatus.textContent = `fired (${onConnectFiredCount}×) for ${account.address.slice(0, 8)}…`;
        log(`onConnect fired #${onConnectFiredCount} for ${account.address}`, "ok");

        try {
            const outcomes = await requestResourceAllocation([
                { tag: "AutoSigning", value: undefined },
            ]);
            if (signal.aborted) {
                log("onConnect aborted before completing", "info");
                return;
            }
            $onConnectResult.textContent = `outcomes: ${outcomes.map((o) => o.tag).join(", ")}`;
            $onConnectResult.classList.remove("err");
        } catch (cause) {
            if (signal.aborted) return;
            $onConnectResult.textContent = `error: ${cause instanceof Error ? cause.message : String(cause)}`;
            $onConnectResult.classList.add("err");
        }
    },
});

// ── Render SignerManager state into the DOM ──────────────────────────
function renderAccounts(state: SignerState): void {
    $accountsList.innerHTML = "";
    if (state.accounts.length === 0) {
        const empty = document.createElement("div");
        empty.className = "meta";
        empty.textContent = "No accounts — click Connect.";
        $accountsList.appendChild(empty);
        return;
    }
    for (const acct of state.accounts) {
        const row = document.createElement("div");
        row.className = "account-row";
        row.dataset.testid = `account-row-${acct.address}`;
        if (state.selectedAccount?.address === acct.address) {
            row.classList.add("selected");
        }
        const name = acct.name ?? "(anon)";
        row.innerHTML = `<span class="name">${name}</span>${acct.address}`;
        row.addEventListener("click", () => {
            const res = manager.selectAccount(acct.address);
            if (!res.ok) log(`selectAccount error: ${res.error.message}`, "err");
        });
        $accountsList.appendChild(row);
    }
}

// `subscribe` fires synchronously on every state mutation: connect/disconnect,
// `selectAccount`, the provider's `onAccountsChange` callback, host swap, etc.
// It does NOT fire with the initial state — getState() is the priming read,
// but the demo doesn't need it because the DOM starts in the "disconnected"
// shape that matches `initialState()`.
//
// This handler is intentionally idempotent and stateless: it re-derives every
// piece of DOM from the snapshot it receives. No "did the status change since
// last time?" logic lives here — that goes in the per-transition hooks below
// (and in `onConnect` above for the "once per connect" case).
manager.subscribe((state) => {
    subscribeFiredCount += 1;
    $subscribeCount.textContent = String(subscribeFiredCount);
    if (state.status !== prevStatus) {
        recordTransition(prevStatus, state.status);
        prevStatus = state.status;
    }
    log(
        `state: status=${state.status} provider=${state.activeProvider ?? "-"} ` +
            `accounts=${state.accounts.length} selected=${state.selectedAccount?.address ?? "-"}`,
        "state",
    );
    $connectionStatus.textContent = state.status;
    $activeProvider.textContent = state.activeProvider ?? "-";
    $selectedAddress.textContent = state.selectedAccount?.address ?? "-";

    // Errors live in their own slot so e2e tests can assert on them
    // without scraping the noisier event log.
    if (state.error) {
        $lastError.textContent = `${state.error.name}: ${state.error.message}`;
    }

    renderAccounts(state);

    // Enablement is derived, not stored — we don't track "did sign succeed?"
    // anywhere. After the user clicks Sign, the `finally` block re-reads
    // `getState()` because a disconnect could have fired mid-sign, in which
    // case the post-sign button-enable logic must NOT re-enable the button.
    const connected = state.status === "connected" && state.selectedAccount !== null;
    $rawInput.disabled = !connected;
    $btnSignRaw.disabled = !connected;
    $btnConnect.disabled = state.status !== "disconnected";
    $btnDisconnect.disabled = state.status === "disconnected";
    $btnReconnect.disabled = state.status === "connecting";
    $dotnsInput.disabled = !connected;
    $btnGetProductAccount.disabled = !connected;
});

// ── Actions ──────────────────────────────────────────────────────────
async function doConnect(): Promise<void> {
    $lastError.textContent = "";
    log("connect() …");
    const res = await manager.connect();
    if (!res.ok) {
        log(`connect error: ${res.error.message}`, "err");
        $lastError.textContent = `${res.error.name}: ${res.error.message}`;
        return;
    }
    log(`connected with ${res.value.length} accounts`, "ok");
    if (res.value.length > 0 && !manager.getState().selectedAccount) {
        const select = manager.selectAccount(res.value[0].address);
        if (!select.ok) {
            log(`selectAccount error: ${select.error.message}`, "err");
        }
    }
}

$btnConnect.addEventListener("click", () => {
    doConnect().catch((err) => log(`unhandled connect error: ${(err as Error).message}`, "err"));
});

$btnDisconnect.addEventListener("click", () => {
    log("disconnect()");
    manager.disconnect();
});

$btnReconnect.addEventListener("click", () => {
    log("reconnect (disconnect + connect)");
    manager.disconnect();
    doConnect().catch((err) =>
        log(`unhandled reconnect error: ${(err as Error).message}`, "err"),
    );
});

$btnGetProductAccount.addEventListener("click", async () => {
    $lastError.textContent = "";
    $productAccountAddress.textContent = "";
    $productAccountAddress.classList.remove("err");

    const dotNs = $dotnsInput.value.trim() || "signer-demo.dot";
    log(`getProductAccount("${dotNs}", 0) …`);
    $btnGetProductAccount.disabled = true;
    try {
        const res = await manager.getProductAccount(dotNs, 0);
        if (res.ok) {
            $productAccountAddress.textContent = res.value.address;
            log(`product account: ${res.value.address}`, "ok");
        } else {
            $productAccountAddress.textContent = `${res.error.name}: ${res.error.message}`;
            $productAccountAddress.classList.add("err");
            $lastError.textContent = `${res.error.name}: ${res.error.message}`;
            log(`getProductAccount error: ${res.error.message}`, "err");
        }
    } finally {
        const state = manager.getState();
        $btnGetProductAccount.disabled = !(
            state.status === "connected" && state.selectedAccount !== null
        );
    }
});

$btnSignRaw.addEventListener("click", async () => {
    $lastError.textContent = "";
    $lastSignature.textContent = "";
    $lastSignature.classList.remove("err");

    const text = $rawInput.value ?? "";
    const bytes = new TextEncoder().encode(text);
    log(`signRaw("${text}") — ${bytes.length} bytes`);

    $btnSignRaw.disabled = true;
    try {
        const res = await manager.signRaw(bytes);
        if (res.ok) {
            const hex = toHex(res.value);
            $lastSignature.textContent = hex;
            log(`signature: ${hex.slice(0, 18)}…`, "ok");
        } else {
            log(`signRaw error: ${res.error.name}: ${res.error.message}`, "err");
            $lastSignature.textContent = `${res.error.name}: ${res.error.message}`;
            $lastSignature.classList.add("err");
            $lastError.textContent = `${res.error.name}: ${res.error.message}`;
        }
    } finally {
        // Re-enable via subscribe state callback — safer than a local flag
        // in case disconnect fired mid-sign.
        const state = manager.getState();
        $btnSignRaw.disabled = !(state.status === "connected" && state.selectedAccount !== null);
    }
});

// ── Boot ─────────────────────────────────────────────────────────────
log("Booting signer-demo…");
doConnect().catch((err) => log(`unhandled init error: ${(err as Error).message}`, "err"));
