# Merchant Payments Product SDK

## Summary

The Merchant Payments Product SDK defines a product-layer merchant payments API/profile for merchant-side
Coinage payments. A merchant product or SDK can create a payment intent, create
a QR/deep-link invoice, subscribe to merchant checkout status, retrieve a signed
supplemental receipt, inspect merchant operating-balance summary state, and
initiate refunds.

The product never receives merchant Coinage private keys, payer identity, payer
source coin data, statement-store internals, coin/voucher secrets, or raw
private payment evidence. Coinage purse ownership, receivables, cheques,
deposits, clearing references, and refunds are provided by RFC 0017. The Merchant Payments Product SDK defines the
merchant ledger, checkout UX state, receipt shape, refund policy, POS
references, and reconciliation semantics layered above it.

This is not a primitive Coinage host capability like RFC 0017. It is a product-layer SDK profile for composing RFC 0017 CoinPayment primitives with merchant checkout semantics.
RFC 0006 models a user payment from the current user's host to a destination.
RFC 0017 models user-agent-owned Coinage purses, receivables, cheques,
invoices, and deposits. Merchant payments models the acceptance side needed by
terminals, ticketing, invoice, ecommerce, and marketplace products.

## Motivation

RFC 0006 defines a direct Coinage payment request flow. The Merchant Payments Product SDK defines the
merchant checkout layer needed for real-world payment acceptance and POS
integration.

Merchant payments require more than requesting a payment and receiving funds.
They need a privacy-preserving invoice, a merchant Coinage operating balance,
checkout intent lifecycle state, POS reconciliation
references, fiat-denominated quote locking, receipt artifacts, refund linkage,
and clear host/product responsibility boundaries.

This document is not specific to any single terminal UI. The same primitives should
support standalone merchant apps, soft Coinage checkout flows embedded into
third-party POS systems, and integrations with third-party credit-card and
payment terminals.

The merchant/POS-facing primitives are:

- create a checkout intent;
- attach sale amount, currency, and optional POS reference;
- construct and show a standardized invoice as a QR/deep link;
- lock quote if fiat-priced;
- let the customer pay privately;
- rely on the RFC 0017 CoinPayment layer to transmit, deposit, and clear
  cheques;
- update merchant-visible status;
- produce receipt artifacts;
- record enough for reconciliation;
- support refunds by refunding the underlying Coinage receivable when possible;
- avoid exposing payer identity or Coinage internals.

Without a standard merchant layer, each POS integration would invent its own
checkout statuses, receipt fields, refund linkage, and reconciliation records
on top of Coinage, increasing privacy risk and host/product drift.

### Relationship to RFC 0017

RFC 0017 defines the lower-level CoinPayment surface: purses, receivables,
cheques, invoices, deposits, clearing references, purse rebalancing, and
`refund`.

RFC 0017 also defines implementation capability profiles. Merchant products
must treat those profiles as part of their acceptance policy. A production
merchant deployment must require production RFC 0017 CoinPayment capability and
finality support before treating a checkout as settled, issuing a production
receipt, or presenting a payment as real merchant acceptance. Simulated or
staged RFC 0017 hosts may be used for development, demos, pre-release smoke
tests, and integration testing only when the resulting merchant payment state is
clearly non-production.

The Merchant Payments Product SDK should not duplicate those primitives. It uses them as follows:

- merchant/store/terminal operating unit -> one or more RFC 0017 purses;
- checkout QR/deep link -> product-created RFC 0017 `Invoice` carrying a
  `Receivable`;
- customer payment handoff -> RFC 0017 `Cheque` delivered through the invoice's
  transmission channel;
- payment acceptance -> RFC 0017 `deposit(cheque)` status plus merchant policy;
- receipt evidence -> RFC 0017 `Done { cleared, reference }`;
- refund execution -> RFC 0017 `refund(receivable)` using the same clearing
  `Status` shape as deposits;
- end-of-day reporting -> merchant ledger aggregation across one or more
  purses.

Merchant concepts such as terminal attribution, staff permissions, refund
windows, POS references, and receipt wording remain in this SDK profile because they are
product semantics rather than generic Coinage ownership semantics.

## Detailed Design

### Product API

```rust
fn merchant_payment_intent_create(
  request: MerchantPaymentIntentCreate
) -> Result<MerchantPaymentIntent, MerchantPaymentErr>;

fn merchant_payment_intent_get(
  intent_id: PaymentIntentId
) -> Result<MerchantPaymentIntent, MerchantPaymentErr>;

fn merchant_payment_invoice_create(
  request: MerchantPaymentInvoiceCreate
) -> Result<MerchantPaymentInvoice, MerchantPaymentErr>;

fn merchant_payment_intent_status_subscribe(
  request: MerchantPaymentIntentStatusSubscribe,
  callback: fn(MerchantPaymentStatusEvent)
) -> Result<Subscriber, MerchantPaymentErr>;

fn merchant_payment_receipt_get(
  intent_id: PaymentIntentId
) -> Result<MerchantPaymentReceipt, MerchantPaymentErr>;

fn merchant_payment_refund_intent_create(
  request: MerchantPaymentRefundIntentCreate
) -> Result<MerchantPaymentRefundIntent, MerchantPaymentErr>;

fn merchant_payment_refund_status_subscribe(
  request: MerchantPaymentRefundStatusSubscribe,
  callback: fn(MerchantPaymentRefundStatusEvent)
) -> Result<Subscriber, MerchantPaymentErr>;

fn merchant_payment_purse_status_get(
  scope: MerchantPaymentScope
) -> Result<MerchantPaymentPurseStatus, MerchantPaymentErr>;
```

### Call Semantics

The signatures above define the product-layer API shape. The semantics below
define what a merchant product or SDK must do when each call is made. Concrete
implementations may expose shorter camelCase helpers, but the behavioral
contract is the `merchant_payment_*` method behavior.

#### `merchant_payment_intent_create`

Creates a product-owned merchant payment intent for a merchant/product scope.

The merchant layer must:

- authenticate the calling product and authorize it for the merchant, product,
  scope, device, and action;
- derive actor information from authenticated principal/device context,
  not from product-supplied role claims;
- validate sale amount, sale currency, payment asset, public context, expiry,
  and external reference shape;
- lock a eurobot quote for EUR-priced sales and store the quote on the intent;
- create and persist the intent record before returning success;
- initialize lifecycle state, normally `invoice = None`,
  `payment = Created` or `Quoted`, `receipt = None`, `refund = None`;
- bind the idempotency key to the successful response and return the same
  intent for equivalent retries;
- return `IdempotencyConflict` if the idempotency key is reused with materially
  different input;
- return an intent that survives product reload and merchant-layer restart.

The product must not choose private keys, receiving addresses, derivation paths,
statement-store topics, or resolver encryption material.

#### `merchant_payment_intent_get`

Returns the product-visible intent snapshot.

The merchant layer must:

- authenticate and authorize the caller for the intent's merchant/product
  scope;
- return the latest persisted aggregate state;
- refresh payment state from Coinage before responding when the merchant layer
  can do so through RFC 0017 or other authorized user-agent primitives;
- persist any observed lifecycle transition before returning it;
- exclude payer identity, payer device IDs, payer source coin IDs, raw payment
  evidence, private receiving material, and resolver secrets.

#### `merchant_payment_invoice_create`

Creates or returns a customer-facing invoice session for an intent.

The merchant layer must:

- authenticate and authorize the caller for the intent's merchant/product
  scope;
- check the underlying RFC 0017 CoinPayment capability profile against the
  merchant/product acceptance policy;
- load the persisted intent and fail with `IntentNotFound` if it does not exist
  or is not visible to the caller;
- reject terminal, expired, cancelled, failed, or already-paid intents;
- ensure the locked FX quote is still valid for the configured payment
  confirmation window before publishing an invoice;
- select or create the RFC 0017 purse that should receive this checkout;
- call RFC 0017 `create_receivable(into_purse)` and bind the returned
  `Receivable` to the merchant intent;
- call RFC 0017 `listen_for(receivable)` to obtain a standard transmission
  channel and a future cheque;
- construct a standardized RFC 0017 `Invoice` that includes the payment amount,
  transmission channel, and receivable;
- encode that invoice as the requested QR/deep-link channel;
- persist the invoice session, receivable, invoice hash, channel reference, and
  status transition before returning success;
- return the existing active invoice session for repeated calls with the same
  intent and channel.

The product may construct the visual QR/deep link from the returned payment
invoice. It must not receive merchant private keys, Coinage source coins, raw
coin secrets, voucher secrets, or RFC 0017 private receiving state. A payable
invoice transitions the intent to `invoice = Ready` and
`payment = Pending`.

This method does not imply that Coinage itself needs a merchant "claim session"
API. Invoice sessions are merchant checkout records. The underlying Coinage
layer sees an RFC 0017 receivable, a channel-delivered cheque, and a deposit
operation.

#### `merchant_payment_intent_status_subscribe`

Subscribes to ordered status events for one payment intent.

The merchant layer must:

- authenticate and authorize the caller before installing the subscription;
- surface setup errors through the subscription error path instead of returning
  a successful subscription that will never emit;
- replay events from `from_sequence` when provided, then deliver live events in
  monotonic sequence order;
- deliver only product-visible lifecycle changes;
- exclude payer identity, payer source coin data, raw private payment evidence,
  and private host reconciliation data from events.

#### `merchant_payment_receipt_get`

Returns the product-visible supplemental receipt for a paid intent, if one is
available.

The merchant layer must:

- authenticate and authorize the caller for the intent's merchant/product
  scope;
- return no receipt for an existing unpaid intent rather than fabricating a
  placeholder;
- return the signed customer receipt after merchant acceptance has been
  verified;
- keep the receipt payload structurally separate from merchant-private evidence
  so it cannot contain payer identity, payer device IDs, payer source coin IDs,
  or raw private payment data;
- ensure the signature covers sale amount, payment amount, payment asset, FX
  quote fields when present, accepted timestamp, refund reference when present,
  invoice hash, clearing reference when present, and
  payment evidence hash.

#### `merchant_payment_refund_intent_create`

Creates a refund intent linked to an original paid intent.

The merchant layer must:

- authenticate the caller and authorize refund action for the merchant, product,
  scope, amount, and policy;
- require stronger local authentication or approval when merchant policy
  requires it;
- load the original persisted payment intent and fail if it is missing, unpaid,
  cancelled, failed, or not refundable;
- create a separate refund record linked by `original_intent_id`; it must not
  rewrite the original sale intent into a new sale;
- support partial refunds by tracking cumulative refunded amount against the
  original sale amount;
- fail when the requested refund exceeds the remaining refundable amount;
- bind the refund idempotency key to the successful response and return the same
  refund intent for equivalent retries;
- record whether execution used the original sale quote, a refund-time quote, or
  another host-supported reversal basis;
- call RFC 0017 `refund(receivable)` or an equivalent host-native CoinPayment refund
  primitive when the refund returns the original received coins to the sender;
- persist refund approval/execution state before returning any terminal refund
  status;
- exclude customer identity and payer source coin data from product-visible
  refund records.

#### `merchant_payment_refund_status_subscribe`

Subscribes to ordered status events for one refund intent.

The merchant layer must:

- authenticate and authorize the caller before installing the subscription;
- surface setup errors through the subscription error path;
- replay refund events from `from_sequence` when provided, then deliver live
  events in monotonic sequence order;
- keep refund events linked to the original payment intent without duplicating
  or rewriting the original payment lifecycle;
- exclude customer identity, payer source coin data, raw private payment
  evidence, and private host reconciliation data from events.

#### `merchant_payment_purse_status_get`

Returns a product-visible summary of the merchant operating balance.

The merchant layer must:

- authenticate and authorize the caller for the requested merchant/product
  scope;
- summarize funds without exposing private derivation material, source coin IDs,
  or customer linkage;
- separate available, clearing, cleared, retained-for-refunds, pending
  settlement, and readiness buckets when the merchant layer can determine them;
- never move funds or configure settlement through this read-only call.

The merchant product may expose the same surface through `@parity/product-sdk-merchant-payments` or the umbrella `@parity/product-sdk/merchant-payments` subpath. It is not expected to replace RFC 0017 as a primitive Coinage host capability. Hosts should not need to expose `window.ua.ext.merchantPayments`; products should bundle this SDK and provide it an RFC 0017 CoinPayment adapter.

### Core Types

```rust
struct MerchantPaymentScope {
  merchant_id: str,
  product_id: str,
  scope_id: str,
  location_id: Option<str>,
  product_instance_id: Option<str>
}

struct MerchantPaymentIntentCreate {
  scope: MerchantPaymentScope,
  sale_amount: Money,
  payment_asset: PaymentAsset,
  external_reference: Option<str>,
  display_reference: Option<str>,
  idempotency_key: Option<str>
}

struct MerchantPaymentIntent {
  id: PaymentIntentId,
  scope: MerchantPaymentScope,
  sale_amount: Money,
  payment_amount: AssetAmount,
  fx_quote: Option<FxQuote>,
  status: MerchantPaymentStatus
}

struct MerchantPaymentInvoiceCreate {
  intent_id: PaymentIntentId,
  channel: MerchantPaymentInvoiceChannel,
  idempotency_key: Option<str>
}

enum MerchantPaymentInvoiceChannel {
  StatementStore,
  EmbeddedQr
}

struct MerchantPaymentInvoice {
  id: InvoiceSessionId,
  intent_id: PaymentIntentId,
  receivable: Receivable,
  channel: MerchantPaymentInvoiceChannel,
  invoice: Invoice,
  qr_payload: str,
  deep_link: str,
  expires_at_ms: u64,
  invoice_hash: str
}
```

`MerchantPaymentErr` is a typed domain error, not a free-form string. V1 should
include at least:

```rust
enum MerchantPaymentErr {
  InvalidAmount,
  UnsupportedSaleCurrency,
  UnsupportedPaymentAsset,
  UnsupportedChannel,
  FxQuoteUnavailable,
  FxQuoteExpired,
  InvalidTicketReference,
  IntentNotFound,
  IntentAlreadyTerminal,
  InvoiceExpired,
  InvoiceAlreadyExists,
  StatementStoreUnavailable,
  ReceiptUnavailable,
  CoinPaymentNotProductionReady,
  RefundNotAllowed,
  RefundAmountExceedsOriginal,
  IdempotencyConflict,
  InvalidPublicContext,
  PurseUnavailable,
  PermissionDenied,
  AuthenticationRequired,
  RefundApprovalRequired,
  UserAgentCapabilityUnavailable,
  Internal,
}
```

`PermissionDenied` means the product, actor, device, merchant, product, scope,
or action is not authorized. `AuthenticationRequired` means the merchant layer
can proceed only after stronger local authentication. `UserAgentCapabilityUnavailable`
means an underlying required user-agent primitive or service is unavailable.
`CoinPaymentNotProductionReady` means the underlying RFC 0017 implementation is
available only as a simulated or staged capability, but the merchant/product
policy requires production Coinage settlement.
`Internal` is reserved for unexpected runtime failures and should not be used
for expected business-state errors.

`Invoice` is the standardized customer-facing payment request defined by RFC
0017. The QR/deep link encodes that invoice. It must not contain merchant
private receiving material, coin/voucher secrets, payer-specific data, or raw
payment evidence. V1 supports statement store as the preferred handoff channel
and embedded QR as a fallback.

```rust
struct MerchantPaymentStatus {
  invoice: InvoiceStatus,   // None | Ready | Expired
  payment: PaymentStatus,   // Created | Quoted | Pending | Paid | Expired | Failed | Cancelled
  receipt: ReceiptStatus,   // None | Signed | Delivered
  refund: RefundStatus,     // None | Pending | PartiallyRefunded | Refunded | Failed
  error: Option<str>
}

struct MerchantPaymentStatusEvent {
  intent_id: PaymentIntentId,
  sequence: u64,
  status: MerchantPaymentStatus,
  occurred_at_ms: u64
}
```

`InvoiceStatus` is merchant checkout state, not Coinage state. `Ready` means
the merchant product has an invoice to display. `Expired` is determined by
merchant/product policy from the invoice expiry and locked quote window; it is
not a core RFC 0017 Coinage deposit status. Status subscriptions are ordered
and replayable through `from_sequence`.

### Merchant Checkout Flow Over RFC 0017

A merchant checkout is a product-layer record built over an RFC 0017
receivable, invoice, cheque, and deposit. The expected flow is:

1. Create and persist a merchant payment intent with sale amount, payment asset,
   display reference, external/POS reference, expiry, and idempotency key.
2. Select the RFC 0017 purse for this merchant, store, terminal, or settlement
   unit.
3. Call RFC 0017 `create_receivable(into_purse)` and persist the returned
   `Receivable` on the merchant intent.
4. Call RFC 0017 `listen_for(receivable)` to get a transmission channel and a
   future cheque.
5. Construct an RFC 0017 `Invoice` that includes the requested amount,
   transmission channel, and receivable. Merchant display/reference data may be
   kept in the merchant ledger or encoded in an outer product envelope.
6. Encode the invoice as the requested QR/deep-link channel and transition
   merchant status to `invoice = Ready`, `payment = Pending`.
7. Await the future cheque. Cheque arrival means payment data was transmitted;
   it is not payment finality.
8. Call RFC 0017 `deposit(cheque)` and observe the returned clearing status.
9. Treat `Clearing` as claim/finality progress and continue showing a
   processing state.
10. Mark the merchant intent `Paid`, generate the receipt, and persist the
    clearing reference only after RFC 0017 reports
    `Done { cleared, reference }`.
11. Compare `cleared` with the invoice amount. A mismatch is a merchant ledger
    exception even when Coinage itself completed the deposit.
12. Handle `Failed { error, cleared, reference }`, including low balance,
    denied operations, bad coins, sniped coins, and partially cleared deposits,
    as merchant ledger exceptions.

This flow is intentionally more specific than RFC 0017. RFC 0017 knows only
about purses, receivables, channels, cheques, deposits, and refunds. Merchant Payments Product SDK
decides how those events map to terminal UI, receipt generation, refund policy,
POS references, and merchant reconciliation.

For production merchant acceptance, the underlying RFC 0017 host must advertise
a production CoinPayment profile with finality support before step 10 may
produce a production `Paid` state or production receipt. Simulated or staged
RFC 0017 hosts may exercise the same flow for non-production environments, but
the merchant layer must not allow those results to be mistaken for settled
Coinage funds.

```rust
struct MerchantPaymentReceipt {
  id: ReceiptId,
  merchant_display_name: str,
  scope: MerchantPaymentScope,
  sale_amount: Money,
  payment_amount: AssetAmount,
  fx_quote: Option<FxQuote>,
  display_reference: Option<str>,
  accepted_at_ms: u64,
  refund_reference: Option<str>,
  invoice_hash: str,
  clearing_reference: Option<ClearingReference>,
  payment_evidence_hash: str,
  signature: Vec<u8>
}
```

The receipt payload is separate from merchant private records. It cannot contain
payer identity, payer device ID, payer source coin IDs, coin/voucher secrets, or
raw payment evidence. `clearing_reference` is the RFC 0017 product-visible
clearing reference returned by `Done { cleared, reference }`.

Production receipts must be signed only after production RFC 0017 finality has
been verified. Non-production receipts generated over simulated or staged RFC
0017 references must be distinguishable from production receipt evidence.

Recommended receipt encoding is deterministic CBOR signed as COSE_Sign1 with content type `application/vnd.coinage.merchant-receipt.v1+cbor`. The signature covers sale amount, payment amount, payment asset, FX quote fields, accepted timestamp, refund reference, invoice hash, clearing reference when present, and payment evidence hash.

```rust
struct Money {
  currency: Currency,       // DotUsd | Eur
  minor_units: u128
}

struct AssetAmount {
  asset: PaymentAsset,      // DotUsd in V1
  minor_units: u128
}

struct FxQuote {
  source: str,
  rate_numerator: u128,
  rate_denominator: u128,
  quoted_at_ms: u64,
  expires_at_ms: u64,
  rounding_mode: RoundingMode
}
```

EUR-priced intents lock a eurobot quote for dotUSD payment. If the quote
expires before the customer host accepts the invoice, the intent expires and the
merchant product must create a new intent. Once the customer host accepts the
invoice before expiry, the host honors the locked quote through payment
verification and receipt generation.

Refunds are separate records linked to the original intent. A refund does not rewrite the original payment lifecycle. Refund entitlement and merchant accounting are denominated in the original sale currency. For a EUR-priced sale collected in dotUSD, the refund record must state whether execution used the original sale quote, a refund-time quote, or another host-supported reversal basis.

`merchant_payment_purse_status_get` returns only product-visible summary state
such as available, clearing, cleared, retained-for-refunds, and
pending-settlement amounts. It does not expose private Coinage keys, source
coins, or raw settlement material.

### Merchant Purse and Ledger Model

The merchant layer maintains two related records:

- the merchant ledger: product-visible checkout, receipt, refund, POS reference,
  status, scope, location, device, and reconciliation state;
- the merchant Coinage operating balance: one or more RFC 0017 purses whose
  private inventory is owned and secured by the host.

Products must not receive merchant Coinage private keys, derivation paths,
source coin IDs, coin/voucher secrets, raw payment proofs, or private purse
inventory. Products may only receive product-visible intent/refund/receipt
state, RFC 0017 clearing references, and summary operating-balance buckets such
as available, clearing, cleared, pending settlement, or retained-for-refund.

For each checkout, the merchant layer creates a fresh receivable, transmission
channel, and invoice. The invoice may be wrapped with public display/reference
data, but private Coinage material must not be product-selected or derived from
public values such as POS references, terminal IDs, location IDs, merchant IDs,
invoice identifiers, or statement-store topics.

The underlying RFC 0017 CoinPayment layer may generate fresh random coin account
keys or use a user-agent-private derivation scheme from a user/root secret. If
derivation is used, the path and inputs are user-agent-private implementation
details. This SDK profile requires freshness, non-correlation, authorization,
durability, and recoverability, not a product-visible derivation path.

When a payment is accepted, the merchant layer must update the merchant ledger
and RFC 0017 purse state consistently: mark the intent paid only after
successful cheque deposit, persist clearing/receipt references, record received
Coinage funds, update summary buckets, and preserve enough linkage for refunds
and future settlement reconciliation without exposing payer identity, source
coin data, or raw private evidence.

Merchant ledger records and the underlying RFC 0017 purses must survive product
reload and user-agent restart. Because Coinage ownership depends on private keys
or equivalent user-agent-private derivation material, purse secrets and
inventory must be stored in encrypted durable storage with an appropriate
recovery/backup path.

Purse topology is merchant/product policy. A deployment may use one purse per
merchant/store for operational simplicity, separate purses per terminal or
device for isolation, or separate purses per settlement period when accounting
boundaries matter. Terminal attribution remains in the merchant ledger either
way. Products can aggregate ledger records at the end of day and use RFC 0017
`purse_rebalance` when funds should move between purses. This keeps generic
Coinage purses simple and avoids forcing terminal attribution or staff policy
into the CoinPayment layer.

### Payment Exceptions

RFC 0017 reports Coinage cheque/deposit failures; Merchant Payments Product SDK defines merchant
behavior. In particular, amount mismatch is a merchant exception, not a generic
Coinage policy decision. A receivable is not inherently associated with an
amount, so the merchant layer compares the deposited cheque amount with the
invoice amount.

When the deposited cheque amount is less than the invoice amount, the merchant
layer must not issue a normal paid receipt for the full sale. Product policy
may:

- keep the checkout pending if the invoice/channel supports collecting the
  remaining amount;
- cancel the checkout and attempt RFC 0017 `refund(receivable)` for the received
  portion;
- create a merchant exception requiring owner/operator review;
- issue a receipt only for an explicitly accepted adjusted amount.

When RFC 0017 reports `Failed { error, cleared, reference }` for `BadCoins`,
`SnipedCoins`, `Denied`, or `BalanceLow`, the merchant layer should keep the
original sale unpaid and surface a failed or manual-review state. If `cleared`
is non-zero, the merchant layer should also record the clearing reference and
attempt RFC 0017 `refund(receivable)` or route the case to owner/operator
review. The product must not infer payment completion from raw chain state or
from cheque arrival.

When RFC 0017 `refund(receivable)` fails, the merchant refund record remains
open as an exception. The merchant layer may offer an alternative refund path,
manual settlement, or owner review, but it must not rewrite the original sale
lifecycle.

### Settlement / Offload

Settlement, also called offload, is the merchant-controlled process of moving
funds out of the merchant Coinage operating balance to an external
merchant-controlled destination.

This SDK intentionally does not define settlement execution, destination
configuration, or automated settlement policy. Checkout acceptance and
settlement have different authorization, privacy, accounting, and operational
requirements. A checkout API must keep merchant payment acceptance small and
reliable; a settlement API must answer additional treasury questions such as:

- who may sweep funds;
- which destination types are allowed;
- whether settlement is manual, scheduled, threshold-based, or automatic;
- how much Coinage operating balance should remain retained for refunds;
- how settlement records, fees, failures, retries, and reversals are tracked;
- whether settlement timing or destination choice creates merchant revenue
  correlation risk.

Merchant payment records and operating-balance status must preserve enough
information for a future settlement extension to reconcile accepted payments,
refunds, retained refund windows, and pending settlement. They must not require
settlement to happen during checkout.

Refund retention is merchant policy. A merchant may retain all received funds
for a refund window, retain a configured float, or retain nothing. This SDK does not require a generic RFC 0017 reserve primitive; merchant products can model
retention in their ledger and choose when to rebalance or settle purses.

### Permissions

This SDK does not add a new host permission. Merchant products and
SDKs must use the permissions required by the underlying user-agent capabilities
they compose, especially RFC 0017 `CoinPayment` access and any storage, signing,
statement-store, chain, or local-authentication capabilities used by the
implementation.

Merchant products should deny merchant payment actions by default until the
product, actor, device, merchant, scope, and action are authorized in the
merchant layer. That authorization is product/SDK policy layered above RFC
0017; it does not grant ordinary user payments, raw signing, arbitrary storage,
chat, root-account access, or direct Coinage internals.

Subscriptions are fallible. Product SDKs must surface setup errors rather than
returning an unsubscribe function for a subscription that was never installed.

### Behavioral Requirements

1. Every non-idempotent intent uses a fresh receivable, invoice, and handoff
   location.
2. Statement-store or HOP handoff locations must be random, short-lived, and
   scoped to one checkout.
3. Merchant-visible records must not include payer identity, payer device IDs,
   payer source coin IDs, coin/voucher secrets, or raw payment evidence.
4. The merchant layer marks an intent `Paid` only after RFC 0017
   `deposit(cheque)` reports `Done { cleared, reference }` and the cleared
   amount satisfies merchant policy, unless merchant policy explicitly accepts
   unfinalized risk.
5. EUR-priced receipts must include the locked FX quote and the receipt signature must cover it.
6. Reusing an idempotency key with materially different input returns `IdempotencyConflict`.
7. Merchant records survive product reload and merchant-layer restart.
8. Settlement/offload is outside the checkout path for V1.
9. Invoice expiry produces merchant checkout expiry; it is not a core Coinage
   deposit status.
10. Merchant refunds should use RFC 0017 `refund(receivable)` when returning
    the original payment is possible.
11. Amount mismatches, `BadCoins`, `SnipedCoins`, `Denied`, and `BalanceLow`
    must be handled as merchant ledger exceptions.
12. Production merchant acceptance requires an underlying RFC 0017 production
    CoinPayment profile with finality support.
13. Simulated or staged RFC 0017 implementations may be used for development,
    demos, and integration tests, but merchant products must not present their
    results as production settlement.
14. Production receipts must be backed by production RFC 0017 clearing
    references; non-production receipts must be visibly distinguishable from
    production receipt evidence.

## Drawbacks

**Larger API surface.** Merchant acceptance requires intents, invoices, status,
receipts, refunds, and purse summaries. This is larger than RFC 0006.

**Host implementation burden.** Hosts must integrate Coinage, statement store, eurobot, receipt signing, durable records, and receipt delivery.

**Accounting complexity.** EUR pricing with dotUSD payment introduces FX quote and refund accounting concerns.

**Not a fiscal POS.** Products still need a POS/fiscal system for legal sales records in jurisdictions such as Germany.

## Alternatives

### Use RFC 0006 Payments Directly

Rejected. RFC 0006 does not model merchant invoices, merchant acceptance
evidence, supplemental receipts, terminal attribution, refund linkage, or
reconciliation records.

### Use RFC 0017 Directly

Rejected as the merchant-facing API. RFC 0017 intentionally models only
CoinPayment purses, receivables, cheques, invoices, deposits, refunds, and
clearing references. It does not know what a POS ticket is, when a checkout
should expire, who may approve a refund, how receipts should be signed, or how a
retailer wants to aggregate end-of-day activity.

### Product-Owned Coinage

Rejected. Hosted products must not receive merchant private keys or raw Coinage state.

### Embedded QR Only

Rejected as the default. Embedded QR is a useful fallback, but statement store
or HOP-style handoff can carry larger cheques more cleanly.

### Automated Settlement During Checkout

Rejected for V1. Checkout should avoid public correlation and should not depend on recycler/offload timing.

## Unresolved Questions

- Exact production receipt-signing key lifecycle and verification UX.
- Exact beta and stable package release names and versions.
- Whether additional receipt viewing or receipt delivery UX is needed for V1.
- Exact eurobot quote freshness and payment-confirmation window policy.
- Germany/EU legal and tax review for receipt wording, refunds, VAT correction, and FX accounting.
- Future multi-device/shared-ledger sync across hosts.
