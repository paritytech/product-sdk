---
name: product-sdk-profile
description: >
  Use when a product shows or changes the avatar a person publishes under their DotNS name.
  Reach for it whenever the user mentions a profile, an avatar or profile picture, or a "card"
  for a DotNS or People username, wants to show who a contact is, or wants to let a person
  publish or change their avatar, even if they do not say "profile". Covers getProfile and its
  three answers, getProfileRecord for the text as stored, decodeProfileRecord, loadAvatar
  through the host's preimage lookup and never a gateway, the read-rewrite-prepare-submit-verify
  publish recipe with rewriteProfileRecord, profileAvatar, submitAvatar, prepareSetProfile and
  verifyPublishedProfile, setting and clearing the avatar while every other entry is carried, why
  the SDK never signs, funds or repoints a resolver, the labels it accepts (a DNS label or a
  dotted lite username such as alice.01), and the ProfileError and DotNsError reasons.
---

# Product SDK Profile

`@parity/product-sdk/profile` reads and prepares writes of the **avatar** a person publishes
under their DotNS name: one text record, `profile`, under the name they own. Three reads, four
write steps, and the product does the signing. Everything fallible returns a `Result`.

The avatar is an image on Bulletin, named in the record by its digest and a declared format. The
host core decodes the same bytes to show a contact's avatar, so what this module reads is what
hosts show. The record may hold entries of other kinds; this module skips them on read and
carries them unchanged on write.

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
    const { avatar } = result.value.profile;            // null when the record names none
    const manager = await getPreimageManager();
    const loaded = avatar && manager && (await loadAvatar(avatar, manager));
    if (loaded && loaded.ok && loaded.value.tag === "Loaded") {
        const { bytes, mimeType } = loaded.value.avatar;
        // The cast: TS 5.7 types `bytes` over ArrayBufferLike, which Blob's input does not accept.
        img.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
    }
}
```

## Where Things Are Imported From

The profile module exists only on the umbrella, as `@parity/product-sdk/profile`; there is no
`@parity/product-sdk-profile` package. The umbrella also re-exports the chain client, the
contracts, host and identity packages as `@parity/product-sdk/chain`, `/contracts`, `/host` and
`/identity`. It has **no `/tx` subpath**, so `batchSubmitAndWatch` and `submitAndWatch` come
from `@parity/product-sdk-tx`, and chain descriptors come from `@parity/product-sdk-descriptors`,
both installed beside the umbrella. The signer a write needs is a `CommonSignerTxCreator` (the
type is from `@polkadot-api/signers-common`) for the person's identity account; "Who signs"
below says which account that is and how to get its signer. The `product-sdk-transactions` skill
covers the signer lifecycle.

## What You Must Hand In

Every read and write takes `DotNsClientOptions`, the same options every other DotNS call in
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
| `ok({ tag: "Found", profile })` | the name has a record this reader decodes | render it; `avatar` may be `null` |
| `ok({ tag: "NoProfile" })` | no record, an empty one, or one that is not a profile | clear what was cached |
| `err(DotNsError)` | the chain could not be asked, a reverting `text` call included | keep what was cached, ask again later |

A record in the layout that preceded the RFC reads as `NoProfile`, as the core reads it. A
deployment with no content resolver holds no profiles, so it is `NoProfile` too.

When a record holds several avatar entries, the first that decodes is the avatar, as the core
reads it. An avatar in a format this reader does not know is no avatar.

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
if (loaded.ok && loaded.value.tag === "Loaded") show(loaded.value.avatar); // { cid, format, mimeType, bytes }
```

The bytes come from the host's preimage lookup, keyed by the digest inside the CID, so nobody
outside the host learns whose avatar a viewer looks at. They are kept only if they hash to the
CID and are within the RFC's 2 MiB bound. The MIME type is the format the record declares; the
bytes are never sniffed.

It answers a `Result`, and only `Loaded` carries bytes:

| Answer | Meaning |
| --- | --- |
| `ok({ tag: "Loaded", avatar })` | the bytes hash to the CID |
| `ok({ tag: "Missing" })` | the host had nothing under that key within the timeout |
| `ok({ tag: "Mismatch" })` | the host answered bytes that do not hash to the CID |
| `ok({ tag: "TooLarge" })` | the bytes are over the 2 MiB bound |
| `ok({ tag: "Unreadable" })` | the CID is not a Bulletin preimage CID; the host is not asked |
| `err` | the lookup could not be made: `Host`, `Timeout`, or `Aborted` when `options.signal` fired |

None of these fails the profile: show a placeholder and ask again later. Avatar bytes outlive
nothing: Bulletin drops them after its retention period, and the publisher uploads them again.

## Writes: the publish recipe

The record on chain is one value, so every change is read, change, write back, in the order the
host core's own publisher makes it. The SDK prepares; the product signs, pays and submits.

```typescript
import { batchSubmitAndWatch } from "@parity/product-sdk-tx";
import { ensureContractAccountMapped } from "@parity/product-sdk/contracts";
import { getPreimageManager } from "@parity/product-sdk/host";
import {
    getProfileRecord, prepareSetProfile, profileAvatar, rewriteProfileRecord,
    submitAvatar, verifyPublishedProfile,
} from "@parity/product-sdk/profile";

// `owner` is the account the registry authorises for the name: for a person,
// their identity account, the product account `peopl.<tld>` at index 0. `signer`
// is its CommonSignerTxCreator on extension version 1. See "Who signs" below.
// Fund `owner` before any of this: steps 4 and 6 each cost a fee.
// Reads take no origin; the prepare alone does.
const opts = { runtime };

// 1. The live text. "" means none.
const live = await getProfileRecord("alice", opts);
if (!live.ok) throw live.error;

// 2. The new avatar's entry, from the bytes alone: their digest as a Bulletin CID,
//    no host call. The bytes go to Bulletin in step 5, once the write is prepared.
const avatar = profileAvatar(pngBytes, "png");
if (!avatar.ok) throw avatar.error;

// 3. The new text: the avatar replaced, every other entry carried as read.
const text = rewriteProfileRecord(live.value, { avatar: avatar.value });
if (!text.ok) throw text.error;

// 4. The setText call, sized by a dry-run as the owner. The owner must be mapped
//    in pallet-revive first. An identity account usually is already, from when
//    its username was registered, and then this submits nothing. When it is not,
//    the mapping is a transaction of its own and fails as `Invalid.Payment` on
//    an unfunded account.
await ensureContractAccountMapped(runtime, owner.address, signer);
const prepared = await prepareSetProfile("alice", text.value, { ...opts, origin: owner.address });
if (!prepared.ok) throw prepared.error;

// 5. The avatar bytes, now that the dry-run has sized the write: a write that
//    would fail spends no Bulletin allowance. The host must key them by their digest.
const manager = await getPreimageManager();
const stored = await submitAvatar(pngBytes, manager!);
if (!stored.ok) throw stored.error;

// 6. Submit, after a last look: another writer's record must not be overwritten.
const again = await getProfileRecord("alice", opts);
if (!again.ok || again.value !== prepared.value.original) throw new Error("the profile changed; start over");
const sent = await batchSubmitAndWatch([prepared.value.call], chain.assetHub, signer);
if (!sent.ok) throw sent.error;

// 7. What the chain holds now is what was sent. The read is at the best block,
//    so it works as soon as the write is included; how long to wait is the
//    product's choice (see "Submitting").
const published = await verifyPublishedProfile("alice", prepared.value.text, opts);
```

To take the avatar down, patch `{ avatar: null }` and skip steps 2 and 5; the bytes stay on
Bulletin until they lapse. To clear the whole record, prepare with `""`.

### `rewriteProfileRecord(live, patch)`: what one publish changes

| `patch.avatar` | What the new text holds |
|---|---|
| `undefined` | the record as read |
| `null` | every avatar entry dropped, one in a format this writer does not know included, since a newer reader would still show it |
| a `ProfileAvatar` | the avatar readers show replaced, and the new one first |

Every other entry is carried byte for byte, in its order: an entry of a kind this writer does
not know, and an avatar entry other than the one it replaces. A live text that is not a profile
is **refused**, with the decoder's reason, rather than replaced, so a damaged record is never
overwritten by accident. A product that means to replace it passes `null` as `live`. A record
that would be over 16 KiB is refused as `TooLarge` before it is written, because every reader
would refuse it and the profile would vanish silently.

An avatar no entry can carry is `InvalidEntry`: a CID that is not a Bulletin preimage CID.

### `profileAvatar(bytes, format)` and `submitAvatar(bytes, manager)`

Two steps, in the core's order. `profileAvatar` is pure: the `ProfileAvatar` a record carries for
the bytes, their blake2b-256 digest as a Bulletin CID and the declared format (`png`, `jpeg`,
`webp` or `gif`), refused as `TooLarge` over 2 MiB. It goes straight into the patch, so the record
is rewritten and the write prepared before any host call. The format is the caller's declaration,
as it is for readers; whether the bytes are an image of that format is the product's check, with
the file in hand.

`submitAvatar` is the upload, after the prepare and before the submit, so a write that would fail
spends no Bulletin allowance. The host stores the bytes under the product's allowance and answers
the key, which must be the digest `profileAvatar` wrote; anything else is `Host`. A host that did
not confirm in time is `Timeout`, not `Host`: the bytes may still be stored, and a retry is safe.

### `prepareSetProfile(label, text, opts)`

Signer-free, like every DotNS write in the identity module. It checks the text is a record
readers accept, requires `opts.origin`, asks the registry whether that account is authorised for
the name (its owner, or an address or operator the owner approved, the resolver's own rule), reads
the current text, dry-runs `setText` as the origin and returns `{ call, text, original }`. A
stranger fails as `DotNsError` reason `Unauthorised` before the dry-run; a text no reader accepts
fails as `ProfileError` before the chain is asked.

It never calls `setResolver`. Every name is minted pointing at the reverse resolver, and the
record is still written and read on the deployment's content resolver, because `setText` checks
the registry's authorisation and not the pointer. That is where DotNS keeps text records, where
dotns-sdk reads them, and where the host core's public-profile reader reads a profile (truapi
`public_profile.rs`). Repointing would buy nothing, and it can cost the name its address: an
address is read only while the pointer is the forward resolver, which is where `setDotNsRecord`
puts it.

### What the product owns

- **Who signs.** The account the registry authorises for the name. For a person that is their
  identity account: the product account of `peopl.<tld>` at derivation index 0 (RFC-0028), which
  owns their username. A product that itself runs as `peopl.<tld>` gets it from the accounts
  provider with `getProductAccount("peopl.<tld>", 0)`; any other product needs the host to grant
  it that account. Take the TLD from the network, never a hard-coded one. Build the signer with
  `getProductAccountSigner(account, { txExtVersion: 1 })`: the default version 0 does not carry
  the `AsPgas` extension Asset Hub's fee payment needs.
- **Paying, first.** Fund the identity account before mapping or preparing. Fees on Asset Hub
  are paid in PGAS, and an unfunded account fails its first transaction as `Invalid.Payment`,
  which is the mapping when one is needed. `requestResourceAllocation` from
  `@parity/product-sdk/host` asks the host for the allowance; `Allocated` means the claim was
  submitted, not that the balance has landed, so read the balance until it has before going on.
  The call also takes the record's storage deposit, and the avatar upload spends the product's
  Bulletin allowance. The SDK has no helper for this yet; the `product-sdk-contracts` and
  `product-sdk-transactions` skills cover `AsPgas` and the signer.
- **Mapping, only if needed.** The dry-run and the call run as that account in pallet-revive, so
  it must be mapped **before `prepareSetProfile`**, since the prepare dry-runs as the origin. An
  identity account is normally mapped when its username is registered.
  `ensureContractAccountMapped` from the contracts package checks, and submits the mapping
  transaction only when it is missing.
- **Submitting.** `batchSubmitAndWatch([call], api, signer)` from `@parity/product-sdk-tx` takes
  `prepared.call` as it is, and is how to combine the write with others. For the one call,
  `submitAndWatch(call, signer)` is the plain form; `call` is typed `BatchableCall`, so it needs
  a cast to `SubmittableTransaction` there.
- **How long to wait.** Both resolve at best-block inclusion by default, and
  `verifyPublishedProfile` reads the best block, so the check can run straight away. That is the
  responsive choice, and a reorg can still drop the write. Pass `{ waitFor: "finalized" }` to
  wait it out, or show the avatar at inclusion and verify once more after finality.

## Errors

`ProfileError` reasons: `NotBase64`, `TooLarge`, `Malformed` from the decoder and the rewrite;
`InvalidEntry` from the rewrite; `TooLarge` from `profileAvatar` and `submitAvatar`; `Host` from
`submitAvatar` and `loadAvatar`, for a host call that failed or answered something unusable, with
the cause attached; `Timeout` from the same calls when the host's deadline passed, which an
upload may outlive, so word the retry that way; `Aborted` from `loadAvatar` when its signal fired.
The DotNS walk reports through `DotNsError`: `InvalidName`, `MissingOrigin`, `InvalidOrigin`, `Unauthorised`, `AddressDiscovery` when a write targets a
deployment with no content resolver (a read answers `NoProfile` there, since there is nothing to
read), `RegistryCall` for a call that failed, with the cause. Both implement the `SdkError`
marker, so `isSdkError` recognises them.

## The Record

The `profile` text record is standard base64 of a SCALE `ProfileRecord`: a list of entries, each
carried as length-prefixed bytes that start with the entry's variant index. Index 0 is `Avatar`,
`{ cid: [u8; 32], format: u8 }`, fixed by the RFC "Core-resolved public profiles"; the format
numbers `png` 0, `jpeg` 1, `webp` 2, `gif` 3. A reader keeps entries it cannot decode as opaque
bytes and a writer puts them back, which is what lets a kind be added later without an older
writer erasing it.

## Running It Offline

`examples/profile-example` is the worked version of everything above, against fixtures: read,
load the avatar, then the publish recipe with the product steps stubbed, then a clear. Start
from it for a test or a demo. What it shows that the API does not:

- `createFakeContractRuntime` from `@parity/product-sdk/testing` stands in for DotNS. The SDK
  keeps its DotNS ABIs private, so the fixture declares the three signatures it answers, `text`,
  `isAuthorised` and `setText`, as the example does. Pass `tld` and `contentResolverAddress` so
  the walk stops there.
- Under the fake runtime `prepared.call` is an empty object. Capture what the runtime built
  through `onCall` and apply it from there, as the example's submit stub does.
- The fake host in `@parity/product-sdk/testing` keys a submitted preimage by a cheap hash, and
  `submitAvatar` holds the host to the blake2b-256 digest, so hand-roll a `PreimageManager`
  over a `Map`, as the example and the avatar tests do.

## Common Mistakes

- **Treating `NoProfile` and `err` the same.** One clears the cache, the other keeps it.
- **Rewriting from a decoded profile.** `rewriteProfileRecord` takes the text from
  `getProfileRecord`, not a `PublicProfile`, because it carries entries it does not decode.
- **Mapping after preparing.** The prepare dry-run runs as the origin; an unmapped origin fails
  it. Map first.
- **Mapping or submitting before funding.** Both are transactions; an unfunded identity account
  fails the first one as `Invalid.Payment`. Fund, wait for the balance, then go on.
- **Signing on extension version 0.** `getProductAccountSigner(account)` defaults to it; a
  profile write on Asset Hub needs `{ txExtVersion: 1 }`.
- **Reading with the origin set.** A read given an origin dry-runs as it, so a first-ever
  publish fails at step 1, before mapping. Reads take `{ runtime }`; the prepare takes the origin.
- **Skipping the re-read before submitting.** The prepared call stores a value rewritten from
  `original`; if the record changed, submitting it erases the other write.
- **Uploading the avatar before preparing.** `profileAvatar` needs no host, so rewrite and
  prepare first; `submitAvatar` goes after the dry-run and before the submit. Uploading first
  spends Bulletin allowance on a write that may then fail.
- **Fetching an avatar from a gateway.** The CID is a Bulletin preimage; `loadAvatar` goes through
  the host so no third party learns who is being looked at.
- **Calling `setResolver` first.** Not needed, and it fights `setDotNsRecord`: an address is
  read only while the pointer is the forward resolver, so repointing loses the name's address.
- **Expecting the SDK to find the signer or fund the account.** It prepares; the product publishes.
- **Hard-coding the TLD.** It is read from the chain; `.paseo` and `.dot` are different networks.
