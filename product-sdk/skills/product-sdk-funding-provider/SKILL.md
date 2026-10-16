---
name: product-sdk-funding-provider
description: >
  Build a funding provider's worker with product-sdk: the product that moves value into or out of the
  user's balance when the user picks it in the host's add / withdraw sheet.
  Use when: writing or debugging a funding provider, answering quote asks, crediting the user with a
  top-up, collecting a withdrawal and paying out, refunding a failed payout, showing KYC or an onramp
  widget, saving session state, or testing that a provider resumes after a crash without moving funds
  twice.
  Covers @parity/product-sdk-host/funding-provider (serveFunding, FundingSession, validateAsk, quoteId,
  screenChannel, deriveEntropyAccount) and @parity/product-sdk-host/testing (createFakeFundingHost,
  resumeAtEveryCheckpoint).
---

# Funding providers

A funding provider is a product whose **worker** runs funding sessions. The user picks it in the host's
add or withdraw sheet; the host assigns it the session; its worker takes the user's payment on its own
rail and credits the user with a top-up (in), or collects the user's CASH with a payment request and pays
the user out (out). The host decides the outcome from the top-ups and payments the worker names: the worker
never declares success itself.

| Import | Purpose |
|--------|---------|
| `@parity/product-sdk-host/funding-provider` | `serveFunding`, the session, quotes, screens, accounts |
| `@parity/product-sdk-host/testing` | a fake funding core, and the resume-at-every-crash harness |

It is a subpath of the host package, so products that are not funding providers do not carry it. The RFC
behind it is `docs/rfcs/funding-modality.md` in `paritytech/trinity-user-agents`. The module
follows its draft, so names can still move between releases.

## The shape of a whole provider

```ts
import { serveFunding, validateAsk, quoted } from "@parity/product-sdk-host/funding-provider";

type State = { phase: "new" } | { phase: "paid"; order: string };

serveFunding<State>(
    {
        onQuote: (ask) => {
            const served = validateAsk(ask, { directions: ["In"], countries: { Card: ["PT", "ES"] }, min: 10n });
            return served.ok ? quoted(price(ask)) : served.error;
        },
        async onAssigned(session) {
            if (session.state.phase === "new") {
                await session.awaitingPayment();
                const order = await session.action("order", (key) => myApi.createOrder({ idempotencyKey: key }));
                const page = await session.presentPage(order.widgetUrl, "https://pay.example/done");
                if (page.tag !== "Returned" || page.params.get("status") !== "paid") session.fail("Cancelled");
                await session.checkpoint({ phase: "paid", order: order.id });
            }
            await session.paymentReceived({ finalized: true });
            const account = await session.account();
            await session.credit("topup/0", { amount: session.amount!, source: account.topUpSource() });
            await session.delivered();
        },
    },
    { state: { version: 1, initial: () => ({ phase: "new" }) } },
);
```

`onAssigned` is written as a phase machine on `session.state`, because **it runs again after every
restart**: the host replays every session still in flight when the worker comes back, with the state it
last checkpointed.

## The one rule: save before you act

A worker can be killed between any two lines. The library makes the dangerous steps safe by construction:

- **Funds move only through journaled steps.** `credit`, `collect` and `refund` (and the lower-level
  `topUp` and `request`) write their step to a journal and save it with the host **before** asking the
  host to move funds. The id comes from `deriveId(intent, step)`, so a restarted worker asks again under
  the same id and the host answers `AlreadyExists`: the funds move once.
- **External calls go through `session.action(step, run)`.** `run` gets the step's id; pass it to your
  API as the idempotency key. A step that started but did not finish runs again with the same key; a
  finished one returns its saved result.
- **Your own progress goes through `session.checkpoint(next)`.** Checkpoint the phase you are entering,
  then do it. `state` only changes once the host has stored it.
- **Waits are saved too.** Save the time you wait for, then `session.waitUntil(at)`, so a restart waits
  only the rest.

Steps by convention: `"topup/0"`, `"topup/1"`, `"topup/2"` (the core takes three top-ups per session),
`"payment"`, `"refund"`, `"order"`.

Saved state is JSON with bigints kept as they are, inside a versioned envelope. Bump `version` on an
incompatible change and give `migrate`; anything unreadable starts the session from `initial`, but the
journal survives, so funds still never move twice. The host keeps 4 KiB per session, envelope included.

## Reports

Report through the helpers: `awaitingPayment`, `paymentReceived`, `converting`, `delivered`, `deposit`,
`details`, `payout`, `payoutRetrying`, and `fail(reason)`. `crediting`, `collecting` and `refunding` are
sent for you by `credit`, `collect` and `refund`.

The core only takes updates forward. After a restart a report may already be stored; the session knows
the core's last step and answers `"already"` instead of sending it, and an `OutOfOrder` on a top-up or
payment this session started also counts as already reported. Any other `OutOfOrder` or a `NotStarted` is
a provider bug and throws `ReportRefusedError`. `NotFound` throws `SessionOverError`: the session ended,
and `serveFunding` ends it quietly.

How a session ends:

| `onAssigned` | Becomes |
|---|---|
| resolves | the session is done for this provider |
| `session.fail("Declined")` | reported `Failed { Declined }`, unless funds are moving |
| user cancel before money moved | reported `Failed { Cancelled }` |
| user accepts a cancel offer | `onAssigned` is stopped and `onCancelAccepted` settles the cancel |
| any other throw | logged, and the session is handed out again after a doubling wait |

## Cancelling

Before money moved (`session.cancellable`: nothing started, and the user's payment not reported received)
a cancel stops the session by default; `onCancel` can keep it going. Pass `session.signal` to everything
that waits, so a cancel unwinds at once.

After money moved a cancel is a request, and only the provider can end the session:

```ts
onCancelRequest: (session) =>
    canStillUndo(session)
        ? { offer: { fee: FEE, refund: session.amount! - FEE, expiresAt: Date.now() + 5 * 60_000 } }
        : { refuse: "The payout already left" },
async onCancelAccepted(session) {
    const reserve = await session.account("reserve");
    await session.refund("refund", { amount: session.cancel!.refund, source: reserve.topUpSource() });
},
```

- The host shows the offer to the user. `onCancelAccepted` runs once they accept, after `onAssigned` was
  stopped, on a fresh signal: refund a withdrawal (at most what the user paid), or `session.fail("Refunded")`
  a top-up whose payment goes back on the user's rail (the default for a top-up).
- A declined or lapsed offer calls `onCancelDeclined` and `onAssigned` carries on. While an offer is open,
  call `await session.untilCancelDecided()` before the step the cancel would undo, the credit or the payout:
  it returns once the offer is gone and throws when the user accepted.
- With no `onCancelRequest` every cancel after money moved is refused. The host refuses a cancel of a
  top-up whose credit started; the provider is not asked.
- The offer and an acceptance are saved with the session, and the host hands the request or the answer
  back after a restart, so a cancel settles once.

## A withdrawal

```ts
async onAssigned(session) {
    if (session.state.phase === "new") {
        const paid = await session.collect("payment", { amount: session.amount!, destination: MY_ACCOUNT });
        if (paid.tag !== "Completed") session.fail("Cancelled");
        await session.checkpoint({ phase: "released" });
    }
    if (session.state.phase === "released") {
        const outcome = await session.holdWorker("payout", () => myApi.payout(...));
        await session.payout(outcome.ok ? { tag: "PaidOut" } : { tag: "Failed", value: { reason: outcome.reason } });
        await session.checkpoint({ phase: outcome.ok ? "done" : "refunding" });
    }
    if (session.state.phase === "refunding") {
        const reserve = await session.account("reserve");
        await session.refund("refund", { amount: session.amount!, source: reserve.topUpSource() });
    }
}
```

The session is released once the user's payment completes; `converting`, `payoutRetrying`, `payout` and
`refunding` only make sense after that, and the session keeps waiting for them retried. A failed payout,
or a cancel the user accepted, is refunded with a top-up the provider names in `Refunding`; the host ends
the session once it is claimed.

## Quotes

`onQuote` answers every ask the host sends, whatever the provider's manifest routes say. It has 9 s.
`validateAsk(ask, policy)` refuses what the provider does not serve, `refuse.*` builds other refusals,
`quoted(quote)` answers. The assignment hands back only the chosen `FundingQuote`, not the rail, asset or
network it priced: put them in the id with `quoteId.encode(terms)` and read them back with
`quoteId.decode(session.quote!.quoteId)`. The id is not authenticated; keep prices you must trust on your
own servers and put their reference in `extra`.

## Screens

- `session.presentPage(url, returnUrl)` shows an external https page, such as an onramp widget. When it
  navigates to `returnUrl` the host closes it and you get the URL and its query.
- `session.presentApp(route)` shows a route of your own App, with `intent` in its query.
- `screenChannel(prefix)` lets an App screen hand the user's choice back to the worker through host
  storage: the worker `show`s a view and waits for an action of a kind; the App reads it with
  `screenSession(prefix, route)` and answers with `submitScreenAction(prefix, intent, action)`.

## Accounts

`session.account(label)` derives an sr25519 account from host entropy, scoped to the user and your
product: the same after a restart, with no secret to store. `"session/<intent>"` (the default) for one
session, `"reserve"` for one per user. `topUpSource()` is what `credit` and `refund` take to pull its
funds into the user's balance.

## Testing

```ts
import { createFakeFundingHost, resumeAtEveryCheckpoint } from "@parity/product-sdk-host/testing";

test("resumes from every crash", async () => {
    await resumeAtEveryCheckpoint(handlers, SPEC, { direction: "In", amount: 50n }, {
        outcome: "Delivered",
        updates: ["AwaitingPayment", "PaymentReceived", "Crediting", "Delivered"],
    });
});
```

The fake follows the core's rules for a session and settles at once from status scripts you can set.
`resumeAtEveryCheckpoint` runs the session once, then once more for every call the worker makes, crashing
it right after that call and resuming on what the host kept. It fails if the session ends differently, if
funds start under a different id than without a crash, or if a report is refused `NotStarted`. Pass
`drive` to act as the user during every run, such as cancelling once the withdrawal is released and
accepting the offer with `host.cancel(intent)` and `host.confirmCancel(intent, true)`. Use
`createFakeFundingHost` directly for anything else: asks, cancels, frames, faults.

## Not in this module

How you take payments, price, convert and pay out stays yours: those are the provider's business. Never
port code from getcash into product-sdk: it is GPL-3.0, and a test fails if any package imports it.
