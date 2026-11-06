---
name: product-sdk-profile
description: >
  Use when a product shows or edits the public profile a person publishes under their dotNS
  name: an avatar, a display name, pinned NFTs and the feeds the profile points at. Reach for
  it whenever the user mentions a profile, an avatar, a display name, a bio or a "card" for a
  dotNS or People username, wants to show who a contact is, or wants to let a person publish or
  change what others see about them, even if they do not say "profile". Covers getProfile and
  its three answers, getProfileRecord for the text as stored, decodeProfileRecord, loadAvatar
  through the host's preimage lookup and never a gateway, getPinnedNfts and why a pin is
  confirmed against the chain, the read-rewrite-prepare-submit-verify publish recipe with
  rewriteProfileRecord, submitAvatar, prepareSetProfile and verifyPublishedProfile, the
  ProfilePatch carry rules, why the SDK never signs, funds or repoints a resolver, moods on the
  profile's feed (deriveMoodFeed in every publish, setMood, readMood, watchMood, the fixed
  palette MOOD_KINDS and MOOD_INTENSITIES, and SignerMismatch meaning publish first), the labels
  it accepts (a DNS label or a dotted lite username such as alice.01), the ProfileError and
  DotNsError reasons, the record layout and PROFILE_ENTRY_INDEX where the next entry kind is
  claimed.
---

# Product SDK Profile

`@parity/product-sdk/profile` reads and prepares writes of a person's **public profile**: one
dotNS text record, `profile`, under the name they own. Four reads, five write steps, a mood
feed, and the product does the signing. Everything fallible returns a `Result`.

A profile today carries an avatar on Bulletin, a display name, pinned Scarcity NFTs and the
statement-store feeds it points at (a mood feed, for one). The host core decodes the same bytes
to show a contact's avatar, so what this module reads is what hosts show.

## Quick Start

```typescript
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { getChainAPI } from "@parity/product-sdk/chain";
import { createContractRuntimeFromClient } from "@parity/product-sdk/contracts";
import { getPreimageManager } from "@parity/product-sdk/host";
import { getProfile, loadAvatar } from "@parity/product-sdk/profile";

const chain = await getChainAPI("paseo");
const runtime = createContractRuntimeFromClient(chain.raw.assetHub, paseo_asset_hub);

const result = await getProfile("alice", { runtime });
if (!result.ok) showStale();                           // the chain could not be asked: keep what you have
else if (result.value.tag === "NoProfile") clearCard(); // no record, or none a reader accepts
else {
    const { avatar, name, nfts, feeds } = result.value.profile;
    heading.textContent = name ?? "alice";
    const manager = await getPreimageManager();
    const loaded = avatar && manager && (await loadAvatar(avatar, manager));
    // The cast: TS 5.7 types `bytes` over ArrayBufferLike, which Blob's input does not accept.
    if (loaded) img.src = URL.createObjectURL(new Blob([loaded.bytes as BlobPart], { type: loaded.mimeType }));
}
```

## Where Things Are Imported From

The profile module exists only on the umbrella, as `@parity/product-sdk/profile`; there is no
`@parity/product-sdk-profile` package. The umbrella also re-exports the chain client, the
contracts, host, nfts and identity packages as `@parity/product-sdk/chain`, `/contracts`,
`/host`, `/nfts` and `/identity`. It has **no `/tx` subpath**, so `batchSubmitAndWatch` and
`submitAndWatch` come from `@parity/product-sdk-tx`, and chain descriptors come from
`@parity/product-sdk-descriptors`, both installed beside the umbrella. Moods use the host's
statement store and entropy, `getStatementStore` and `deriveEntropy` from `/host`. The signer a write
needs is a `CommonSignerTxCreator`, which `SignerManager` in `@parity/product-sdk-signer`
hands out per account; the host package exposes the accounts provider, not the signer type.
The `product-sdk-transactions` skill covers that lifecycle.

## What You Must Hand In

Every read and write takes `DotNsClientOptions`, the same options every other dotNS call in
`@parity/product-sdk/identity` takes. Two matter here:

- `runtime`: a `ContractRuntime` over Asset Hub, from `createContractRuntimeFromClient(client.raw.assetHub, descriptor)`.
  The record is a contract view call, so a chain client alone is not enough.
- `origin`: the SS58 account that will sign. Required for `prepareSetProfile`, and it must be
  the account the registry authorises for the name. Leave it out of reads: a read dry-runs as
  the origin it is given, and an account pallet-revive has never mapped cannot dry-run.

The TLD and the content resolver are read from the chain once per runtime and cached. Pass
`tld` and `contentResolverAddress` to skip those reads, as the tests and the example do; a live
app leaves both out. Never hard-code `.dot`, the TLD belongs to the network.

## Labels

`label` is the name without its TLD, `alice` or `alice.01`; a trailing `.<tld>` is tolerated,
and the label is trimmed and lower-cased. Two shapes are accepted, the two the core resolves a
profile for:

- a DNS label: lowercase letters, digits and hyphens, no edge hyphen, at most 63 characters;
- a dotted lite username: a letters-only stem, one dot, exactly two digits, at most 32 bytes.

`alice.1` is not a lite name and `Alice!` is not a label; both fail as `DotNsError` with reason
`InvalidName` before anything is asked of the chain. A lite name's parts are levels of the
node, `alice` under `01` under the TLD, which `namehash` does for you.

## Reads

### `getProfile`: three answers, kept apart on purpose

| Answer | Meaning | What a UI does |
|---|---|---|
| `ok({ tag: "Found", profile })` | the name has a record this reader decodes | render it; `avatar` and `name` may each be `null` |
| `ok({ tag: "NoProfile" })` | no record, an empty one, or one that is not a profile | clear what was cached |
| `err(DotNsError)` | the chain could not be asked, a reverting `text` call included | keep what was cached, ask again later |

A record in the layout that preceded the RFC reads as `NoProfile`, as the core reads it. A
deployment with no content resolver holds no profiles, so it is `NoProfile` too.

Nothing is cached. The record changes rarely, so the product decides its own refresh cadence
and uses `avatar.cid` to skip fetching bytes it already holds.

### `getProfileRecord`: the text as stored

`""` for none, otherwise the base64 exactly as the resolver holds it, trimmed. This is what a
write starts from, and what to compare against before submitting one. `decodeProfileRecord(text)`
turns it into a `PublicProfile`, with reasons `NotBase64`, `TooLarge` (over 16 KiB) or `Malformed`
when it is not one.

### `loadAvatar`: through the host, never a gateway

```typescript
const manager = await getPreimageManager();           // null outside a host
const loaded = await loadAvatar(profile.avatar, manager, { timeoutMs: 30_000 });
```

The bytes come from the host's preimage lookup, keyed by the digest inside the CID, so nobody
outside the host learns whose avatar a viewer looks at. They are kept only if they hash to the
CID and are within the RFC's 2 MiB bound. The MIME type is the format the record declares; the
bytes are never sniffed. `null` means "not this time": the host had nothing under that key within
the timeout, the bytes did not match, or the CID is not a Bulletin preimage CID. The profile is
not failed by it; show the name and ask again later. Avatar bytes outlive nothing: Bulletin
drops them after its retention period, and the publisher uploads them again.

### `getPinnedNfts`: the chain, not the record, says what is still held

A pin says "this purse holds this instance, minted from this collection and item". The record
is the owner's claim; `getPinnedNfts(chain, profile.nfts)` checks it against `Scarcity.Instances`
and the display read of `@parity/product-sdk-nfts`, at one block, and answers `pins` (confirmed,
with a display) and `dropped` (with a reason: `NotFound`, `Moved` or `Mismatch`). Draw only the
confirmed ones. `chain` is the nfts package's chain contract plus `Scarcity.Instances`; a
`getChainAPI("paseo")` client satisfies it. Pass `{ at }` from another result to read at the
same block. A pin's `purse` is the holding account as 32-byte hex; `accountIdToHex` in
`@parity/product-sdk/identity` makes it from an SS58 address.

Feeds come back as data, `{ kind, topic, signer }`, and are not subscribed to here.

## Writes: the publish recipe

The record on chain is one value, so every change is read, change, write back, in the order the
host core's own publisher makes it. The SDK prepares; the product signs, pays and submits.

```typescript
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";
import { createContractRuntimeFromClient, ensureContractAccountMapped } from "@parity/product-sdk/contracts";
import { deriveEntropy, getPreimageManager, getStatementStore } from "@parity/product-sdk/host";
import {
    deriveMoodFeed, getProfileRecord, prepareSetProfile, rewriteProfileRecord, submitAvatar,
    verifyPublishedProfile,
} from "@parity/product-sdk/profile";

// `owner` is the account the registry authorises for the name, and `signer`
// its CommonSignerTxCreator, from `SignerManager` over the host accounts
// provider. Finding it is the product's job: for a person it is the account
// that owns their username. Reads take no origin; the prepare alone does.
const opts = { runtime };

// 1. The live text. "" means none.
const live = await getProfileRecord("alice", opts);
if (!live.ok) throw live.error;

// 2. A new avatar goes to Bulletin first, so the record never names bytes that are not there.
const manager = await getPreimageManager();
const avatar = await submitAvatar(pngBytes, "png", manager!);
if (!avatar.ok) throw avatar.error;

// 3. The record's mood feed, in every publish: the topic and signer are stable
//    per wallet and product, so the entry never changes, and it is in the
//    record before any mood is set. Its proof needs the statement-store
//    allowance, requested before this. See Moods below.
const store = await getStatementStore();
const feed = await deriveMoodFeed("alice", opts, store!, deriveEntropy);
if (!feed.ok) throw feed.error;

// 4. The new text: this patch's kinds replaced, everything else carried as read.
const text = rewriteProfileRecord(live.value, {
    avatar: avatar.value, name: "Alice", feeds: [feed.value],
});
if (!text.ok) throw text.error;

// 5. Map the account before preparing, not after. The dry-run that sizes the
//    call runs as the owner, and pallet-revive refuses a dry-run from an
//    account it has never mapped. A no-op once the account is mapped.
await ensureContractAccountMapped(runtime, owner.address, signer);

// 6. The setText call, sized by a dry-run as the owner.
const prepared = await prepareSetProfile("alice", text.value, { ...opts, origin: owner.address });
if (!prepared.ok) throw prepared.error;

// 7. Submit, after a last look: another writer's record must not be overwritten.
const again = await getProfileRecord("alice", opts);
if (!again.ok || again.value !== prepared.value.original) throw new Error("the profile changed; start over");
const sent = await batchSubmitAndWatch([prepared.value.call], chain.assetHub, signer, { waitFor: "finalized" });
if (!sent.ok) throw sent.error;

// 8. What the chain holds now is what was sent. Only after finality: a
//    best-block inclusion can still be reorged away.
const published = await verifyPublishedProfile("alice", prepared.value.text, opts);
```

To clear the record, prepare with `""`. To take an avatar down, patch `{ avatar: null }`; the
bytes stay on Bulletin until they lapse.

### `rewriteProfileRecord(live, patch)`: what one publish changes

| Field | `undefined` | `null` | a value |
|---|---|---|---|
| `avatar` | keep what is there | drop every avatar entry | replace the first avatar this writer decodes, and put the new one first |
| `name` | keep | drop | replace; empty is refused, so there is no third meaning |
| `nfts` | keep | drop all | replace the whole list, since the pins are one list |
| `feeds` | keep | drop all | replace only the kinds named, so the mood feed leaves a feed of another kind alone |

Every entry of a kind this writer does not know is carried byte for byte, and so is an avatar
in a format it does not know or a feed it cannot read: not its to drop. A live text that is not
a profile is **refused**, with the decoder's reason, rather than replaced, so a damaged record is
never overwritten by accident. A product that means to replace it passes `null` as `live`. A
record that would be over 16 KiB is refused as `TooLarge` before it is written, because every
reader would refuse it and the profile would vanish silently.

A patch value no entry can carry is `InvalidEntry`: a CID that is not a Bulletin preimage CID, an
empty name or one over 64 bytes of UTF-8, a purse, topic or signer that is not 32 bytes of hex,
an instance id outside u64.

### `submitAvatar(bytes, format, manager)`

Refuses bytes over 2 MiB before the host is asked. The format is the caller's declaration, as it
is for readers; whether the bytes are an image of that format is the product's check, with the
file in hand. The host stores the bytes under its Bulletin allowance and answers the key, which
must be the blake2b-256 digest of the bytes; anything else is a `Host` error and no CID. The
`ProfileAvatar` that comes back goes straight into the patch.

### `prepareSetProfile(label, text, opts)`

Signer-free, like every dotNS write in the identity module. It checks the text is a record
readers accept, requires `opts.origin`, asks the registry whether that account is authorised for
the name (its owner, or an address or operator the owner approved, the resolver's own rule), reads
the current text, dry-runs `setText` as the origin and returns `{ call, text, original }`. A
stranger fails as `DotNsError` reason `Unauthorised` before the dry-run; a text no reader accepts
fails as `ProfileError` before the chain is asked.

It never calls `setResolver`. A name minted through the gateway is parked on the reverse
resolver, and the record is still written and read on the deployment's content resolver, because
`setText` checks the registry's authorisation and not the pointer, and every reader that matters,
the host core and this SDK, finds the record there. Repointing would buy nothing and would fight
the address record's pointer.

### What the product owns

- **Who signs.** The account the registry authorises for the name. For a person that is the
  account that owns their username; products find it the way their own identity flow does.
- **Mapping.** The dry-run and the call run as that account in pallet-revive, so it must be mapped
  once, and **before `prepareSetProfile`**, since the prepare dry-runs as the origin.
  `ensureContractAccountMapped` from the contracts package does it and is a no-op after.
- **Paying.** The call costs a fee and the record's storage deposit, in the chain's fee asset,
  from the signing account. Funding it is the product's flow, not the SDK's.
- **Submitting.** `batchSubmitAndWatch([call], api, signer)` or `submitAndWatch`, from
  `@parity/product-sdk-tx`, with `waitFor: "finalized"` before verifying.

## Moods

A mood is one statement on the name's mood topic in the statement store, signed by the host's
statement allowance key, gone a day after it was set. The record's `mood` feed names the topic
and the signer, and `getProfile` hands it back in `profile.feeds`. Setting a mood never writes
the record: one proof through the host, one submit, no transaction, no prompt.

```typescript
import { getStatementStore } from "@parity/product-sdk/host";
import { MOOD_INTENSITIES, MOOD_KINDS, readMood, setMood, watchMood } from "@parity/product-sdk/profile";

const store = (await getStatementStore())!;              // null outside a host
const feed = profile.feeds.find((f) => f.kind === "mood");
if (!feed) showNoMood();                                   // the record names no feed: publish first
else {
    const mood = await readMood(feed, store);              // ok(Mood | null); err: keep what was shown
    const watch = watchMood(feed, store, (mood) => render(mood)); // ok(watch); watch.value.unsubscribe() on close
    await setMood(feed, { kind: "focused", intensity: "steady" }, store); // the person's own
    await setMood(feed, null, store);                      // clear
}
```

- **The palette is the SDK's.** `MOOD_KINDS` is `calm`, `focused`, `hyped`, `social`, `low-key`,
  `away`; `MOOD_INTENSITIES` is `soft`, `steady`, `loud`. The index is what travels, so every
  product shows the same intent for the same bytes. It grows by appending, never renumbering,
  and an index a build does not know reads as no mood. Build pickers from the constants.
- **The feed goes in every publish.** `deriveMoodFeed(label, opts, store, deriveEntropy)`
  derives the topic from host entropy and learns the signer from a proof it never submits;
  both are stable per wallet and product. Put it in every publish patch, so the topic is in
  the record before any mood is set and a record another product built is taken over. It
  replaces the record's mood feed by kind: the product that published last is the one whose
  moods show. The proof needs the statement-store allowance, so request that first.
- **`SignerMismatch` means publish first.** The host signs as this product's key. If the record
  names another's, `setMood` refuses before submitting, because no reader would show the mood.
  Publish the record from this product, with its feed in the patch, then set.
- **A read that fails is not "no mood".** `readMood` answers `ok(null)` when nothing is live and
  `err` (`Host`, `Timeout`) when the host could not be read. Keep what was shown on `err`.
- **`watchMood` reports once the backfill is in, then on change**, including to null when the
  mood lapses with no new statement. Unsubscribe when the card closes.
- **The product requests the allowance.** Statements are sponsored by the statement-store
  allowance: request `{ tag: "StatementStoreAllowance" }` in the same resource request as the
  first publish's gas and Bulletin, so it is one approval, and before `deriveMoodFeed`, whose
  proof needs it. The SDK asks for nothing.

## Errors

`ProfileError` reasons: `NotBase64`, `TooLarge`, `Malformed` from the decoder and the rewrite;
`InvalidEntry` and `TooLarge` from the rewrite, `submitAvatar` and `getPinnedNfts`; `ChainRead`
from `getPinnedNfts`, with the cause attached; `Host` from `submitAvatar` and the mood functions,
for a host call that failed or answered something unusable, with the cause attached where there
is one; `SignerMismatch` and `Timeout` from the mood functions. The dotNS walk reports through
`DotNsError`: `InvalidName`, `MissingOrigin`, `InvalidOrigin`, `Unauthorised`, `AddressDiscovery`
when a write targets a deployment with no content resolver (a read answers `NoProfile` there, since
there is nothing to read), `RegistryCall` for a call that failed, with the cause.
Both implement the `SdkError` marker, so `isSdkError` recognises them.

## The Record

`PROFILE_ENTRY_INDEX` is `{ avatar: 0, name: 1, nft: 2, feed: 3 }`, the variant index that starts
every entry. Index 0 is fixed by the RFC "Core-resolved public profiles"; 1 to 3 are proposed
here and written by Seity. The table in `types.ts` is where the next index is claimed, with its
payload, its reader rule and a pinned test vector; an index is never reused and a payload never
changes once a writer has published it. The core keeps the kinds it does not know as opaque
bytes, which is what makes claiming here safe.

## Running It Offline

`examples/profile-example` is the worked version of everything above, against fixtures: read,
load the avatar, confirm the pins, then the publish recipe with the product steps stubbed. Start
from it for a test or a demo. What it shows that the API does not:

- `createFakeContractRuntime` from `@parity/product-sdk/testing` stands in for dotNS. The SDK
  keeps its dotNS ABIs private, so the fixture declares the three signatures it answers, `text`,
  `isAuthorised` and `setText`, as the example does. Pass `tld` and `contentResolverAddress` so
  the walk stops there.
- Under the fake runtime `prepared.call` is an empty object. Capture what the runtime built
  through `onCall` and apply it from there, as the example's submit stub does.
- The fake host in `@parity/product-sdk/testing` keys a submitted preimage by a cheap hash, and
  `submitAvatar` holds the host to the blake2b-256 digest, so hand-roll a `PreimageManager`
  over a `Map`, as the example and the avatar tests do.
- Nothing exports a chain double for `getPinnedNfts`; the example's Scarcity stand-in is the
  shape to copy.
- For moods, a `HostStatementStore` double keeps one statement per signer and channel, proves
  with the feed's signer, and delivers a topic's statements as a page with `isComplete`. The
  example has one, and `deriveEntropy` can be any 32-byte hash of the context.

## Common Mistakes

- **Treating `NoProfile` and `err` the same.** One clears the cache, the other keeps it.
- **Rewriting from a decoded profile.** `rewriteProfileRecord` takes the text from
  `getProfileRecord`, not a `PublicProfile`, because it carries entries it cannot decode.
- **Mapping after preparing.** The prepare dry-run runs as the origin; an unmapped origin fails
  it. Map first.
- **Reading with the origin set.** A read given an origin dry-runs as it, so a first-ever
  publish fails at step 1, before mapping. Reads take `{ runtime }`; the prepare takes the origin.
- **Skipping the re-read before submitting.** The prepared call stores a value rewritten from
  `original`; if the record changed, submitting it erases the other write.
- **Fetching an avatar from a gateway.** The CID is a Bulletin preimage; `loadAvatar` goes through
  the host so no third party learns who is being looked at.
- **Calling `setResolver` first.** Not needed, and it fights `setDotNsRecord`.
- **Expecting the SDK to find the signer or fund the account.** It prepares; the product publishes.
- **Hard-coding the TLD.** It is read from the chain; `.paseo` and `.dot` are different networks.
- **Setting a mood before the record names the feed.** A mood on a topic no record names is seen
  by nobody. Publish with `deriveMoodFeed` in the patch first; `SignerMismatch` is that signal.
- **Keeping a palette of your own.** Use `MOOD_KINDS` and `MOOD_INTENSITIES`; the index is the
  convention across products.
