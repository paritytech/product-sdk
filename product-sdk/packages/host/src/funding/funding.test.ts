// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import type { FundingFrameOutcome, FundingUpdate, HexString } from "@parity/truapi";
import { describe, expect, test } from "vitest";

import {
    FAST_FUNDING_TIMING,
    type FakeFundingHost,
    createFakeFundingHost,
    resumeAtEveryCheckpoint,
} from "./fake.js";
import { deriveId } from "./ids.js";
import { quoted, refuse, validateAsk } from "./quotes.js";
import { screenChannel, screenSession, submitScreenAction } from "./screen.js";
import { type FundingProviderHandlers, serveFunding } from "./serve.js";
import type { FundingSession } from "./session.js";
import type { SavedStateSpec } from "./state.js";

const PAYEE = `0x${"ee".repeat(32)}` as HexString;

/** An onramp's order API, idempotent by key, as a provider's own API should be. */
function onramp() {
    const orders = new Map<HexString, string>();
    return {
        orders,
        async createOrder(key: HexString) {
            if (!orders.has(key)) orders.set(key, `order-${orders.size + 1}`);
            return { id: orders.get(key) as string };
        },
    };
}

// ── a card top-up ──────────────────────────────────────────────────────────

type CardState = { phase: "new" } | { phase: "paid"; order: string };
const CARD_SPEC: SavedStateSpec<CardState> = { version: 1, initial: () => ({ phase: "new" }) };

function cardProvider(api = onramp()): FundingProviderHandlers<CardState> {
    return {
        onQuote: (ask) => {
            const served = validateAsk(ask, { directions: ["In"], min: 10n });
            if (!served.ok) return served.error;
            return quoted({
                quoteId: "q",
                sendAmount: ask.amount,
                receiveAmount: ask.amount,
                providerFee: 0n,
                networkFee: 0n,
                assetDecimals: 2,
            });
        },
        async onAssigned(session) {
            if (session.state.phase === "new") {
                await session.awaitingPayment();
                await session.details({ reference: `ref-${session.intent}` });
                const order = await session.action("order", (key) => api.createOrder(key));
                await session.checkpoint({ phase: "paid", order: order.id });
            }
            await session.paymentReceived({ finalized: true });
            const account = await session.account();
            await session.credit("topup/0", {
                amount: session.amount ?? 0n,
                source: account.topUpSource(),
            });
            await session.delivered();
        },
    };
}

// ── a withdrawal whose payout fails and is refunded ────────────────────────

type PayoutState = { phase: "new" } | { phase: "released" } | { phase: "refunding" };
const PAYOUT_SPEC: SavedStateSpec<PayoutState> = { version: 1, initial: () => ({ phase: "new" }) };

const refundingProvider: FundingProviderHandlers<PayoutState> = {
    onQuote: () => refuse.unavailable(),
    async onAssigned(session) {
        const amount = session.amount ?? 0n;
        if (session.state.phase === "new") {
            const paid = await session.collect("payment", { amount, destination: PAYEE });
            if (paid.tag !== "Completed") return session.fail("Cancelled");
            await session.checkpoint({ phase: "released" });
        }
        if (session.state.phase === "released") {
            await session.holdWorker("payout", async () => {
                await session.converting();
                await session.payout({ tag: "Failed", value: { reason: "the bank refused it" } });
            });
            await session.checkpoint({ phase: "refunding" });
        }
        const reserve = await session.account("reserve");
        await session.refund("refund", { amount, source: reserve.topUpSource() });
    },
};

async function serve<S>(
    host: FakeFundingHost,
    handlers: FundingProviderHandlers<S>,
    spec: SavedStateSpec<S>,
) {
    const controller = new AbortController();
    serveFunding(handlers, {
        client: host.connect(),
        state: spec,
        timing: FAST_FUNDING_TIMING,
        signal: controller.signal,
    });
    return controller;
}

describe("resuming after a crash", () => {
    test("a card top-up resumes from every call without moving funds twice", async () => {
        const api = onramp();
        const { crashPoints } = await resumeAtEveryCheckpoint(
            cardProvider(api),
            CARD_SPEC,
            { direction: "In", amount: 50n },
            {
                outcome: "Delivered",
                updates: ["AwaitingPayment", "PaymentReceived", "Crediting", "Delivered"],
            },
        );
        expect(crashPoints).toBeGreaterThan(5);
        // One order per session id, whatever the crashes: the action's key is fixed.
        expect(new Set(api.orders.values()).size).toBe(1);
    });

    test("a refunded withdrawal resumes from every call", async () => {
        const { crashPoints } = await resumeAtEveryCheckpoint(
            refundingProvider,
            PAYOUT_SPEC,
            { direction: "Out", amount: 30n },
            { outcome: "Released", updates: ["Collecting", "Converting", "Payout", "Refunding"] },
        );
        expect(crashPoints).toBeGreaterThan(5);
    });
});

describe("serveFunding", () => {
    test("delivers a card top-up and names the top-up the session started", async () => {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction: "In", amount: 50n });
        const worker = await serve(host, cardProvider(), CARD_SPEC);
        const session = await host.settled(intent);
        worker.abort();
        expect(session.stage).toEqual({ tag: "Delivered", credited: 50n });
        const crediting = session.updates.find((u) => u.tag === "Crediting");
        expect(crediting).toEqual({
            tag: "Crediting",
            value: { topUpId: deriveId(intent, "topup/0"), amount: 50n },
        });
    });

    test("answers quotes and refuses what the policy does not serve", async () => {
        const host = createFakeFundingHost();
        const worker = await serve(host, cardProvider(), CARD_SPEC);
        const ask = { direction: "In" as const, rail: "Card" as const, asset: "EUR", amount: 50n };
        expect(await host.ask(ask)).toMatchObject({ tag: "Quoted" });
        expect(await host.ask({ ...ask, amount: 5n })).toEqual(refuse.belowMinimum(10n));
        worker.abort();
    });

    test("an ask the provider cannot answer in time is refused as unavailable", async () => {
        const host = createFakeFundingHost();
        const worker = await serve(
            host,
            { ...cardProvider(), onQuote: () => new Promise(() => {}) },
            CARD_SPEC,
        );
        const ask = { direction: "In" as const, rail: "Card" as const, asset: "EUR", amount: 50n };
        expect(await host.ask(ask)).toEqual(refuse.unavailable());
        worker.abort();
    });

    test("a cancel before funds move ends the session as cancelled", async () => {
        const host = createFakeFundingHost();
        let started: () => void = () => {};
        const waiting = new Promise<void>((resolve) => {
            started = resolve;
        });
        const intent = host.assign({ direction: "In", amount: 50n });
        const worker = await serve(
            host,
            {
                ...cardProvider(),
                async onAssigned(session) {
                    await session.awaitingPayment();
                    started();
                    await new Promise((_resolve, reject) =>
                        session.signal.addEventListener("abort", () =>
                            reject(new Error("aborted")),
                        ),
                    );
                },
            },
            CARD_SPEC,
        );
        await waiting;
        expect(host.cancel(intent)).toBe("Requested");
        const session = await host.settled(intent);
        worker.abort();
        expect(session.stage).toEqual({ tag: "Failed", reason: { tag: "Cancelled" } });
    });

    test("session.fail ends the session with its reason", async () => {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction: "In", amount: 50n });
        const worker = await serve(
            host,
            {
                ...cardProvider(),
                async onAssigned(session) {
                    await session.awaitingPayment();
                    session.fail("VerificationRefused");
                },
            },
            CARD_SPEC,
        );
        const session = await host.settled(intent);
        worker.abort();
        expect(session.stage).toEqual({ tag: "Failed", reason: { tag: "VerificationRefused" } });
    });

    test("a session that throws is handed out again and finishes", async () => {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction: "In", amount: 50n });
        let attempts = 0;
        const handlers = cardProvider();
        const worker = await serve(
            host,
            {
                ...handlers,
                async onAssigned(session) {
                    attempts += 1;
                    if (attempts === 1) throw new Error("the onramp is down");
                    await handlers.onAssigned(session);
                },
            },
            CARD_SPEC,
        );
        const session = await host.settled(intent);
        worker.abort();
        expect(attempts).toBe(2);
        expect(session.stage.tag).toBe("Delivered");
    });
});

describe("funds", () => {
    test("starting a top-up again under its step resumes it", async () => {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction: "In", amount: 50n });
        const results: Array<{ resumed: boolean }> = [];
        const worker = await serve(
            host,
            {
                ...cardProvider(),
                async onAssigned(session) {
                    const source = (await session.account()).topUpSource();
                    results.push(await session.topUp("topup/0", { amount: 50n, source }));
                    // A second worker would find the step in its journal; force the
                    // host round trip to show AlreadyExists is a resume.
                    results.push(await session.topUp("topup/0", { amount: 50n, source }));
                    await session.crediting(deriveId(session.intent, "topup/0"), 50n);
                    await session.delivered();
                },
            },
            CARD_SPEC,
        );
        await host.settled(intent);
        worker.abort();
        expect(results).toEqual([
            { id: deriveId(intent, "topup/0"), resumed: false },
            { id: deriveId(intent, "topup/0"), resumed: true },
        ]);
        expect(host.log.filter((entry) => entry.call === "topUp").map((e) => e.answer)).toEqual([
            "ok",
            "AlreadyExists",
        ]);
    });

    test("a step cannot change what it started", async () => {
        const host = createFakeFundingHost();
        host.assign({ direction: "In", amount: 50n });
        let thrown: unknown;
        const worker = await serve(
            host,
            {
                ...cardProvider(),
                async onAssigned(session) {
                    const source = (await session.account()).topUpSource();
                    await session.topUp("topup/0", { amount: 50n, source });
                    try {
                        await session.topUp("topup/0", { amount: 60n, source });
                    } catch (error) {
                        thrown = error;
                    }
                    session.fail("Cancelled");
                },
            },
            CARD_SPEC,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        worker.abort();
        expect(thrown).toBeInstanceOf(TypeError);
    });
});

describe("the core's report order", () => {
    /** A session with `history` stored, then `update` reported. */
    async function reportAfter(
        direction: "In" | "Out",
        setup: (session: {
            host: FakeFundingHost;
            intent: string;
            report: (update: FundingUpdate) => Promise<string>;
            topUp: (id: HexString, amount: bigint) => Promise<string>;
            request: (id: HexString, amount: bigint) => Promise<string>;
        }) => Promise<void>,
        update: FundingUpdate,
    ): Promise<string> {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction, amount: 10n });
        const client = host.connect();
        const answer = (result: {
            match: (a: () => string, b: (e: unknown) => string) => Promise<string>;
        }) =>
            result.match(
                () => "ok",
                (error) => (error as { value: { value: { tag: string } } }).value.value.tag,
            );
        const helpers = {
            host,
            intent,
            report: (u: FundingUpdate) =>
                answer(client.fundingProvider.report({ intent, update: u })),
            topUp: (id: HexString, amount: bigint) =>
                answer(
                    client.payment.topUp({
                        id,
                        amount,
                        source: { tag: "PrivateKey", value: { sr25519SecretKey: "0x00" } },
                    }),
                ),
            request: (id: HexString, amount: bigint) =>
                answer(client.payment.request({ id, amount, destination: PAYEE })),
        };
        await setup(helpers);
        return helpers.report(update);
    }

    const A = `0x${"0a".repeat(32)}` as HexString;
    const B = `0x${"0b".repeat(32)}` as HexString;
    const C = `0x${"0c".repeat(32)}` as HexString;
    const D = `0x${"0d".repeat(32)}` as HexString;
    const crediting = (id: HexString, amount = 10n): FundingUpdate => ({
        tag: "Crediting",
        value: { topUpId: id, amount },
    });
    const released = async (s: Parameters<Parameters<typeof reportAfter>[1]>[0]) => {
        await s.request(A, 10n);
        await s.report({ tag: "Collecting", value: { paymentId: A, amount: 10n } });
    };
    const failedPayout: FundingUpdate = {
        tag: "Payout",
        value: { outcome: { tag: "Failed", value: { reason: "x" } } },
    };

    // Rows mirror the cases of the core's own `follows` and
    // `report_after_release` tests (host_logic/funding.rs in trinity-user-agents).
    test.each<[string, "In" | "Out", Parameters<typeof reportAfter>[1], FundingUpdate, string]>([
        ["the first step", "In", async () => {}, { tag: "AwaitingPayment" }, "ok"],
        [
            "a step it already has",
            "In",
            async (s) => void (await s.report({ tag: "AwaitingPayment" })),
            { tag: "AwaitingPayment" },
            "OutOfOrder",
        ],
        [
            "a step back",
            "In",
            async (s) =>
                void (await s.report({ tag: "PaymentReceived", value: { finalized: true } })),
            { tag: "PaymentReceived", value: { finalized: false } },
            "OutOfOrder",
        ],
        [
            "Collecting on a top-up",
            "In",
            async () => {},
            { tag: "Collecting", value: { paymentId: A, amount: 10n } },
            "OutOfOrder",
        ],
        ["Crediting on a withdrawal", "Out", async () => {}, crediting(A), "OutOfOrder"],
        ["a top-up never started", "In", async () => {}, crediting(A), "NotStarted"],
        [
            "a top-up at another amount",
            "In",
            async (s) => void (await s.topUp(A, 10n)),
            crediting(A, 9n),
            "NotStarted",
        ],
        [
            "a top-up it started",
            "In",
            async (s) => void (await s.topUp(A, 10n)),
            crediting(A),
            "ok",
        ],
        [
            "a top-up named twice",
            "In",
            async (s) => {
                await s.topUp(A, 10n);
                await s.report(crediting(A));
            },
            crediting(A),
            "OutOfOrder",
        ],
        [
            "a fourth top-up",
            "In",
            async (s) => {
                for (const id of [A, B, C]) {
                    await s.topUp(id, 10n);
                    await s.report(crediting(id));
                }
                await s.topUp(D, 10n);
            },
            crediting(D),
            "OutOfOrder",
        ],
        ["Delivered with no top-up", "In", async () => {}, { tag: "Delivered" }, "OutOfOrder"],
        [
            "Failed once funds move",
            "In",
            async (s) => {
                await s.topUp(A, 10n);
                await s.report(crediting(A));
            },
            { tag: "Failed", value: { reason: { tag: "Cancelled" } } },
            "OutOfOrder",
        ],
        [
            "a deposit once funds move",
            "In",
            async (s) => {
                await s.topUp(A, 10n);
                await s.report(crediting(A));
            },
            {
                tag: "Deposit",
                value: {
                    deposit: {
                        tag: "Bank",
                        value: { amount: 1n, currency: "EUR", decimals: 2, reference: "r" },
                    },
                },
            },
            "OutOfOrder",
        ],
        [
            "Details any time",
            "In",
            async (s) => {
                await s.topUp(A, 10n);
                await s.report(crediting(A));
            },
            { tag: "Details", value: { reference: "r" } },
            "ok",
        ],
        [
            "a step after the session failed",
            "In",
            async (s) =>
                void (await s.report({ tag: "Failed", value: { reason: { tag: "Expired" } } })),
            { tag: "AwaitingPayment" },
            "NotFound",
        ],
        [
            "a payout before release",
            "Out",
            async () => {},
            { tag: "Payout", value: { outcome: { tag: "PaidOut" } } },
            "OutOfOrder",
        ],
        [
            "a payout after release",
            "Out",
            released,
            { tag: "Payout", value: { outcome: { tag: "PaidOut" } } },
            "ok",
        ],
        [
            "a second payout",
            "Out",
            async (s) => {
                await released(s);
                await s.report({ tag: "Payout", value: { outcome: { tag: "PaidOut" } } });
            },
            { tag: "PayoutRetrying" },
            "OutOfOrder",
        ],
        ["Converting after release", "Out", released, { tag: "Converting" }, "ok"],
        [
            "Converting twice after release",
            "Out",
            async (s) => {
                await released(s);
                await s.report({ tag: "Converting" });
            },
            { tag: "Converting" },
            "OutOfOrder",
        ],
        [
            "a pre-release step after release",
            "Out",
            released,
            { tag: "Collecting", value: { paymentId: A, amount: 10n } },
            "NotFound",
        ],
        [
            "a refund with no failed payout",
            "Out",
            async (s) => {
                await released(s);
                await s.report({ tag: "Payout", value: { outcome: { tag: "PaidOut" } } });
            },
            { tag: "Refunding", value: { topUpId: B, amount: 10n } },
            "OutOfOrder",
        ],
        [
            "a refund it started after a failed payout",
            "Out",
            async (s) => {
                await released(s);
                await s.report(failedPayout);
                await s.topUp(B, 10n);
            },
            { tag: "Refunding", value: { topUpId: B, amount: 10n } },
            "ok",
        ],
        [
            "a second refund",
            "Out",
            async (s) => {
                await released(s);
                await s.report(failedPayout);
                await s.topUp(B, 10n);
                await s.report({ tag: "Refunding", value: { topUpId: B, amount: 10n } });
            },
            { tag: "Refunding", value: { topUpId: B, amount: 10n } },
            "OutOfOrder",
        ],
    ])("%s", async (_name, direction, setup, update, expected) => {
        expect(await reportAfter(direction, setup, update)).toBe(expected);
    });

    test("a cancel is refused once the provider holds the payment", async () => {
        const host = createFakeFundingHost();
        const intent = host.assign({ direction: "In", amount: 10n });
        await host
            .connect()
            .fundingProvider.report({
                intent,
                update: { tag: "PaymentReceived", value: { finalized: false } },
            })
            .match(
                () => {},
                () => {},
            );
        expect(host.cancel(intent)).toBe("Refused");
    });
});

describe("screen channel", () => {
    test("the worker shows a screen and gets the action the App submits", async () => {
        const host = createFakeFundingHost({
            frame: (): FundingFrameOutcome => ({ tag: "Closed" }),
        });
        const client = host.connect();
        type View = { amount: string };
        type Action = { kind: "confirmed"; at: number };
        const screens = screenChannel<View, Action>("acme", client);
        const intent = host.assign({ direction: "In", amount: 10n });
        let seen: { intent: string; view: View | undefined } | undefined;
        const worker = await serve<{ phase: string }>(
            host,
            {
                onQuote: () => refuse.unavailable(),
                async onAssigned(session: FundingSession<{ phase: string }>) {
                    const action = await screens.show(
                        session,
                        "confirm",
                        { amount: "10" },
                        "confirmed",
                        {
                            onClosed: () => ({ kind: "confirmed", at: 0 }),
                        },
                    );
                    seen = await screenSession<View>("acme", "confirm", client);
                    await submitScreenAction(
                        "acme",
                        session.intent,
                        { kind: "confirmed", at: 1 },
                        client,
                    );
                    expect(action?.kind).toBe("confirmed");
                    session.fail("Cancelled");
                },
            },
            { version: 1, initial: () => ({ phase: "new" }) },
        );
        await host.settled(intent);
        worker.abort();
        expect(seen).toEqual({ intent, view: { amount: "10" } });
    });
});
