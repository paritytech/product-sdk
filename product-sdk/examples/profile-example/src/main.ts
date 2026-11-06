// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { ss58ToH160 } from "@parity/product-sdk/address";
import type { AbiEntry } from "@parity/product-sdk/contracts";
import { blake2b256, bytesToHex as digestHex } from "@parity/product-sdk/crypto";
import type {
    HostStatementStore,
    PreimageManager,
    SignedStatement,
    StatementsPage,
} from "@parity/product-sdk/host";
import { accountIdToHex, dotNsTld, namehash } from "@parity/product-sdk/identity";
import {
    MOOD_FEED_KIND,
    type Mood,
    PROFILE_TEXT_RECORD_KEY,
    type DotNsClientOptions,
    type ProfileNft,
    type ProfileNftsChain,
    getPinnedNfts,
    getProfile,
    getProfileRecord,
    loadAvatar,
    deriveMoodFeed,
    prepareSetProfile,
    readMood,
    rewriteProfileRecord,
    setMood,
    submitAvatar,
    verifyPublishedProfile,
    watchMood,
} from "@parity/product-sdk/profile";
import { type BuiltContractCall, createFakeContractRuntime } from "@parity/product-sdk/testing";
import { type Result, ok } from "@parity/result";
import { decodeFunctionData, type Hex, parseAbi } from "viem";

const LABEL = "alice";
const TLD = dotNsTld(".paseo");
const NODE = namehash(`${LABEL}${TLD.suffix}`, TLD);
const CONTENT_RESOLVER = "0x3333333333333333333333333333333333333333";
/** The account the registry authorises for `alice.paseo`, and the purse that holds her NFTs. */
const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const PURSE = accountIdToHex(OWNER);
const BLOCK = { hash: `0x${"66".repeat(32)}`, number: 100 };
/** Stand-in image bytes. The SDK never sniffs them: the record declares the format. */
const AVATAR_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const pin = (instance: bigint, collection: number, item: number): ProfileNft => ({
    instance,
    collection,
    item,
    purse: PURSE,
});
const HELD = pin(9n, 7, 3);
const GIVEN_AWAY = pin(12n, 7, 4);
const NEW_PIN = pin(21n, 8, 1);

function unwrap<T, E extends Error>(result: Result<T, E>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

// ---------------------------------------------------------------------------
// Fixture: dotNS on Asset Hub.
//
// `createFakeContractRuntime` stands in for pallet-revive. The SDK encodes each
// call with its own dotNS ABIs, which it keeps private, so the fixture mirrors
// the three methods a profile read and write reach: the content resolver's
// `text` and `setText`, and the registry's `isAuthorised`.
// ---------------------------------------------------------------------------

const DOTNS_FIXTURE_ABI = parseAbi([
    "function text(bytes32 node, string key) view returns (string value)",
    "function isAuthorised(bytes32 node, address account) view returns (bool authorisedFlag)",
    "function setText(bytes32 node, string key, string value)",
]);

/** The content resolver's text records, by node. */
const records = new Map<string, string>();
/** The extrinsics `.prepare()` built, which the stubbed submission applies. */
const built: BuiltContractCall[] = [];

const runtime = createFakeContractRuntime({
    // `AbiEntry` takes mutable arrays and viem parses to readonly ones; the
    // entries are the same.
    abi: DOTNS_FIXTURE_ABI as unknown as AbiEntry[],
    onQuery({ functionName, args = [], origin, dest }) {
        switch (functionName) {
            case "text":
                assert.equal(dest.toLowerCase(), CONTENT_RESOLVER);
                assert.equal(args[1], PROFILE_TEXT_RECORD_KEY);
                return records.get(String(args[0])) ?? "";
            case "isAuthorised":
                return (
                    args[0] === NODE &&
                    String(args[1]).toLowerCase() === ss58ToH160(OWNER).toLowerCase()
                );
            case "setText":
                // The dry-run that sizes the call runs as the origin.
                assert.equal(origin, OWNER);
                return undefined;
        }
        throw new Error(`The fixture does not answer ${functionName}.`);
    },
    onCall: (call) => built.push(call),
});

// ---------------------------------------------------------------------------
// Fixture: the host's preimage lookup over Bulletin.
//
// The fake host from `@parity/product-sdk/testing` keys a submitted preimage
// by a cheap hash, and `submitAvatar` holds the host to the blake2b-256 digest
// of the bytes, as the real host answers. So this manager is hand-rolled, as
// the SDK's own avatar tests do.
// ---------------------------------------------------------------------------

const bulletin = new Map<string, Uint8Array>();
const preimages: PreimageManager = {
    async submit(bytes) {
        const key = `0x${digestHex(blake2b256(bytes))}` as const;
        bulletin.set(key, bytes);
        return key;
    },
    lookup(key, callback) {
        queueMicrotask(() => callback(bulletin.get(key) ?? null));
        return { unsubscribe() {}, onInterrupt: () => () => {} };
    },
};

// ---------------------------------------------------------------------------
// Fixture: Scarcity on Asset Hub, at one finalized block.
//
// Instance 12 was minted to the owner and has since moved to another account.
// ---------------------------------------------------------------------------

const instances = new Map([
    [HELD.instance, { collection: HELD.collection, item: HELD.item, owner: OWNER }],
    [
        GIVEN_AWAY.instance,
        { collection: GIVEN_AWAY.collection, item: GIVEN_AWAY.item, owner: OTHER },
    ],
    [NEW_PIN.instance, { collection: NEW_PIN.collection, item: NEW_PIN.item, owner: OWNER }],
]);

const nftChain: ProfileNftsChain = {
    assetHub: {
        query: {
            Scarcity: {
                ItemDefs: {
                    async getValues(keys, { at }) {
                        assert.equal(at, BLOCK.hash);
                        return keys.map(() => ({
                            supply: 100,
                            live_supply: 40,
                            transferability: { type: "Transferable" },
                        }));
                    },
                },
                Instances: {
                    async getValues(keys, { at }) {
                        assert.equal(at, BLOCK.hash);
                        return keys.map(([id]) => instances.get(id)?.owner);
                    },
                },
            },
        },
        apis: {
            ScarcityApi: {
                async metadata_batch(queries, { at }) {
                    assert.equal(at, BLOCK.hash);
                    return queries.map((query) => {
                        assert.equal(query.type, "Instance");
                        const id = query.value as bigint;
                        const minted = instances.get(id);
                        return {
                            resolved: minted && {
                                type: "Instance" as const,
                                value: {
                                    instance: id,
                                    collection: minted.collection,
                                    item: minted.item,
                                },
                            },
                            collection: [],
                            item: [],
                            instance: [],
                        };
                    });
                },
            },
        },
    },
    raw: {
        assetHub: {
            getFinalizedBlock: async () => BLOCK,
            getBestBlocks: async () => [BLOCK],
        },
    },
};

// ---------------------------------------------------------------------------
// Fixture: the host's statement store on the People chain, and its entropy.
//
// The store keeps one statement per signer and channel and replaces it only
// for a higher expiry; a mood's channel is its topic, so one is live at a
// time. The host proves with its statement allowance key, `MOOD_SIGNER` here,
// and derives entropy per wallet and product, a hash here.
// ---------------------------------------------------------------------------

const MOOD_SIGNER: Hex = `0x${"ab".repeat(32)}`;
const statements = new Map<string, SignedStatement>();
const listeners = new Set<{ topic: string; callback: (page: StatementsPage) => void }>();
const onTopic = (topic: string) =>
    [...statements.values()].filter((s) => s.topics.some((t) => String(t) === topic));

const statementStore: HostStatementStore = {
    subscribe(filter, callback) {
        const topic = String(("matchAll" in filter ? filter.matchAll : filter.matchAny)[0]);
        const listener = { topic, callback };
        listeners.add(listener);
        // The backfill, after `subscribe` returns, then live pages as they come.
        queueMicrotask(() => callback({ statements: onTopic(topic), isComplete: true }));
        return { unsubscribe: () => listeners.delete(listener), onInterrupt: () => () => {} };
    },
    async createProofAuthorized() {
        return {
            tag: "Sr25519",
            value: { signature: `0x${"00".repeat(64)}`, signer: MOOD_SIGNER },
        };
    },
    async submit(statement) {
        const key = `${MOOD_SIGNER}:${statement.channel}`;
        const live = statements.get(key);
        if (live && (live.expiry ?? 0n) >= (statement.expiry ?? 0n)) return;
        statements.set(key, statement);
        for (const l of listeners) {
            if (statement.topics.some((t) => String(t) === l.topic)) {
                l.callback({ statements: [statement], isComplete: true });
            }
        }
    },
};
/** The host's entropy derivation, per wallet and product; a hash stands in. */
const deriveEntropy = async (context: Uint8Array) => ok(blake2b256(context));

// ---------------------------------------------------------------------------
// Product-side steps, stubbed.
// ---------------------------------------------------------------------------

/**
 * A live app signs and submits with the owner's signer, paying the fee and the
 * record's storage deposit, and waits for finality before verifying:
 *
 *     const sent = await batchSubmitAndWatch([call], chain.assetHub, signer, { waitFor: "finalized" });
 *     if (!sent.ok) throw sent.error;
 *
 * Here the fixture chain applies the `setText` call the fake runtime built,
 * which is what `prepared.call` stands for; under the fake, the call object
 * itself is empty, so the stub reads the runtime's record of it.
 */
async function submitAndFinalize(): Promise<void> {
    const extrinsic = built.at(-1);
    assert.ok(extrinsic);
    assert.equal(extrinsic.dest.toLowerCase(), CONTENT_RESOLVER);
    const { functionName, args } = decodeFunctionData({
        abi: DOTNS_FIXTURE_ABI,
        data: `0x${digestHex(extrinsic.data)}`,
    });
    assert.equal(functionName, "setText");
    const [node, key, value] = args as readonly [Hex, string, string];
    assert.equal(key, PROFILE_TEXT_RECORD_KEY);
    records.set(node, value);
}

// ---------------------------------------------------------------------------

// A live app omits `tld` and `contentResolverAddress`: both are read from the
// chain once per runtime. The fixture supplies them.
const opts: DotNsClientOptions = {
    runtime,
    tld: TLD,
    contentResolverAddress: CONTENT_RESOLVER,
};

/**
 * The record `alice.paseo` starts with, written with the SDK's own encoder.
 * Its mood feed is the one every publish from this product writes.
 */
async function seedRecord(): Promise<void> {
    const avatar = unwrap(await submitAvatar(AVATAR_BYTES, "png", preimages));
    const feed = unwrap(await deriveMoodFeed(LABEL, opts, statementStore, deriveEntropy));
    const text = unwrap(
        rewriteProfileRecord(null, {
            avatar,
            name: "Alice",
            nfts: [HELD, GIVEN_AWAY],
            feeds: [feed],
        }),
    );
    records.set(NODE, text);
}

async function main(): Promise<void> {
    await seedRecord();

    // --- Read ---------------------------------------------------------------
    const lookup = unwrap(await getProfile(LABEL, opts));
    assert.equal(lookup.tag, "Found");
    const { profile } = lookup;
    console.log(`Profile of ${LABEL}${TLD.suffix}`);
    console.log(`  display name: ${profile.name ?? "(none)"}`);
    console.log(
        `  avatar: ${profile.avatar ? `${profile.avatar.format} ${profile.avatar.cid}` : "(none)"}`,
    );
    for (const nft of profile.nfts) {
        console.log(
            `  pinned NFT: instance ${nft.instance} (collection ${nft.collection}, item ${nft.item})`,
        );
    }
    for (const feed of profile.feeds) {
        console.log(`  feed: ${feed.kind} on topic ${feed.topic.slice(0, 10)}…`);
    }

    assert.ok(profile.avatar);
    const loaded = await loadAvatar(profile.avatar, preimages, { timeoutMs: 1_000 });
    assert.ok(loaded, "the avatar bytes hash to the CID");
    assert.deepEqual(loaded.bytes, AVATAR_BYTES);
    console.log(
        `Loaded the avatar through the preimage lookup: ${loaded.bytes.length} bytes, ${loaded.mimeType}.`,
    );

    const pinned = unwrap(await getPinnedNfts(nftChain, profile.nfts));
    assert.deepEqual(
        pinned.pins.map((p) => p.nft.instance),
        [HELD.instance],
    );
    assert.deepEqual(pinned.dropped, [{ nft: GIVEN_AWAY, reason: "Moved" }]);
    for (const { nft, display } of pinned.pins) {
        console.log(
            `  confirmed: instance ${nft.instance}, ${display.transferability ?? "unknown"}`,
        );
    }
    for (const { nft, reason } of pinned.dropped) {
        console.log(`  dropped: instance ${nft.instance}, ${reason}`);
    }
    console.log(`Pins checked at block ${pinned.at.blockNumber}.`);

    // --- Publish ------------------------------------------------------------
    // Reads keep `opts`: a read dry-runs as the origin it is given, and on a
    // live chain an owner who has never called a contract is not yet mapped.
    // The origin goes on the prepare alone.
    const writeOpts: DotNsClientOptions = { ...opts, origin: OWNER };

    // 1. The live text, which every entry this patch does not name is carried from.
    const live = unwrap(await getProfileRecord(LABEL, opts));

    // 2. No avatar change, so nothing goes to Bulletin. A new avatar would go
    //    first, through `submitAvatar`, so the record never names missing bytes.

    // 3. The record's mood feed, in every publish. The topic and signer are
    //    stable per wallet and product, so this is the entry the record already
    //    holds; a record another product built would be taken over here.
    const feed = unwrap(await deriveMoodFeed(LABEL, opts, statementStore, deriveEntropy));

    // 4. The new text. `nfts` replaces the whole list, so it keeps the pins the
    //    chain confirmed and adds one; the pin that moved away is left out.
    const text = unwrap(
        rewriteProfileRecord(live, {
            name: "Alice Liddell",
            nfts: [...pinned.pins.map((p) => p.nft), NEW_PIN],
            feeds: [feed],
        }),
    );

    // 5. A live app maps the owner in pallet-revive here, before preparing,
    //    since the prepare dry-runs as the owner:
    //        await ensureContractAccountMapped(runtime, OWNER, signer);
    //    `signer` is the owner's CommonSignerTxCreator from SignerManager in
    //    @parity/product-sdk-signer. The fake runtime accepts any origin.

    // 6. The setText call, sized by a dry-run as the owner.
    const prepared = unwrap(await prepareSetProfile(LABEL, text, writeOpts));
    assert.equal(prepared.original, live);
    console.log(`Prepared setText for ${OWNER} on ${LABEL}${TLD.suffix}.`);

    // 7. A last look before submitting: a record another writer changed is not overwritten.
    const again = unwrap(await getProfileRecord(LABEL, opts));
    if (again !== prepared.original) throw new Error("The profile changed; start over.");
    await submitAndFinalize();

    // 8. After finality, the chain holds exactly what was sent.
    assert.equal(unwrap(await verifyPublishedProfile(LABEL, prepared.text, opts)), true);

    const after = unwrap(await getProfile(LABEL, opts));
    assert.equal(after.tag, "Found");
    assert.equal(after.profile.name, "Alice Liddell");
    assert.deepEqual(after.profile.avatar, profile.avatar);
    assert.deepEqual(after.profile.feeds, profile.feeds);
    const repinned = unwrap(await getPinnedNfts(nftChain, after.profile.nfts));
    assert.deepEqual(
        repinned.pins.map((p) => p.nft.instance),
        [HELD.instance, NEW_PIN.instance],
    );
    assert.deepEqual(repinned.dropped, []);
    console.log(
        `Verified: "${after.profile.name}", ${repinned.pins.length} confirmed pins, avatar and feed carried (offline fixture).`,
    );

    // --- Mood ---------------------------------------------------------------
    // One statement on the feed's topic, proved by the host; the record is not
    // written. The feed is the one the record names, and a product whose key
    // the record does not name gets SignerMismatch: it publishes first.
    const moodFeed = after.profile.feeds.find((f) => f.kind === MOOD_FEED_KIND);
    assert.ok(moodFeed);
    const seen: (Mood | null)[] = [];
    const watch = unwrap(watchMood(moodFeed, statementStore, (mood) => seen.push(mood)));

    assert.equal(unwrap(await readMood(moodFeed, statementStore)), null);
    const set = unwrap(
        await setMood(moodFeed, { kind: "focused", intensity: "steady" }, statementStore),
    );
    const read = unwrap(await readMood(moodFeed, statementStore));
    assert.deepEqual(read, set);
    console.log(
        `Mood: ${read?.kind}/${read?.intensity}, set at ${read?.setAt}, lapses at ${read?.expiresAt}.`,
    );

    // A clear goes out above the set's expiry, even within the same second, and reads as no mood.
    assert.equal(unwrap(await setMood(moodFeed, null, statementStore)), null);
    assert.equal(unwrap(await readMood(moodFeed, statementStore)), null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
        seen.map((m) => m?.kind ?? null),
        [null, "focused", null],
    );
    watch.unsubscribe();
    console.log("Mood cleared; the watch saw none, focused, none.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
