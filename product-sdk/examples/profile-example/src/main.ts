// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { ss58ToH160 } from "@parity/product-sdk/address";
import type { AbiEntry } from "@parity/product-sdk/contracts";
import { blake2b256, bytesToHex as digestHex } from "@parity/product-sdk/crypto";
import type { PreimageManager } from "@parity/product-sdk/host";
import { dotNsTld, namehash } from "@parity/product-sdk/identity";
import {
    type DotNsClientOptions,
    type ProfilePatch,
    getProfile,
    getProfileRecord,
    loadAvatar,
    prepareSetProfile,
    profileAvatar,
    rewriteProfileRecord,
    submitAvatar,
    verifyPublishedProfile,
} from "@parity/product-sdk/profile";
import { createFakeContractRuntime } from "@parity/product-sdk/testing";
import type { Result } from "@parity/result";
import { parseAbi } from "viem";

const LABEL = "alice";
const TLD = dotNsTld(".paseo");
const NODE = namehash(`${LABEL}${TLD.suffix}`, TLD);
const CONTENT_RESOLVER = "0x3333333333333333333333333333333333333333";
/** The account the registry authorises for `alice.paseo`. */
const OWNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
/** Stand-in image bytes. The SDK never sniffs them: the record declares the format. */
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const FIRST_AVATAR = new Uint8Array([...PNG_HEADER, 1, 2, 3, 4]);
const NEW_AVATAR = new Uint8Array([...PNG_HEADER, 5, 6, 7, 8]);

function unwrap<T, E extends Error>(result: Result<T, E>): T {
    if (!result.ok) throw result.error;
    return result.value;
}

// DotNS on Asset Hub. `createFakeContractRuntime` stands in for pallet-revive;
// the SDK keeps its DotNS ABIs private, so the fixture declares the three
// methods a profile read and write reach.

const DOTNS_FIXTURE_ABI = parseAbi([
    "function text(bytes32 node, string key) view returns (string value)",
    "function isAuthorised(bytes32 node, address account) view returns (bool authorisedFlag)",
    "function setText(bytes32 node, string key, string value)",
]);

/** The content resolver's text records, by node. */
const records = new Map<string, string>();

const runtime = createFakeContractRuntime({
    // `AbiEntry` takes mutable arrays and viem parses to readonly ones; the
    // entries are the same.
    abi: DOTNS_FIXTURE_ABI as unknown as AbiEntry[],
    onQuery({ functionName, args = [] }) {
        switch (functionName) {
            case "text":
                return records.get(String(args[0])) ?? "";
            case "isAuthorised":
                return (
                    args[0] === NODE &&
                    String(args[1]).toLowerCase() === ss58ToH160(OWNER).toLowerCase()
                );
            case "setText":
                return undefined; // the dry-run that sizes the call
        }
        throw new Error(`The fixture does not answer ${functionName}.`);
    },
});

// The host's preimage lookup over Bulletin, keyed by the blake2b-256 digest
// `submitAvatar` holds the host to. The fake host in `/testing` keys by a
// cheap hash, so this one is hand-rolled.

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

// A live app omits `tld` and `contentResolverAddress`: both are read from the
// chain once per runtime. The fixture supplies them.
const opts: DotNsClientOptions = {
    runtime,
    tld: TLD,
    contentResolverAddress: CONTENT_RESOLVER,
};

/** The record `alice.paseo` starts with, written with the SDK's own encoder. */
async function seedRecord(): Promise<void> {
    const avatar = unwrap(profileAvatar(FIRST_AVATAR, "png"));
    unwrap(await submitAvatar(FIRST_AVATAR, preimages));
    records.set(NODE, unwrap(rewriteProfileRecord(null, { avatar })));
}

/**
 * The publish recipe from the live text onward. `bytes` are the new avatar's,
 * uploaded between the prepare and the submit; a clear has none.
 */
async function publish(patch: ProfilePatch, bytes?: Uint8Array): Promise<void> {
    // 1. The live text, which every entry this patch does not name is carried from.
    const live = unwrap(await getProfileRecord(LABEL, opts));

    // 2. The new text.
    const text = unwrap(rewriteProfileRecord(live, patch));

    // 3. A live app maps the owner in pallet-revive here, before preparing,
    //    since the prepare dry-runs as the owner:
    //        await ensureContractAccountMapped(runtime, OWNER, signer);
    //    `signer` is the owner's CommonSignerTxCreator from SignerManager in
    //    @parity/product-sdk-signer. The fake runtime accepts any origin.
    //    Reads keep `opts`: the origin goes on the prepare alone.
    const prepared = unwrap(await prepareSetProfile(LABEL, text, { ...opts, origin: OWNER }));
    console.log(`Prepared setText for ${OWNER} on ${LABEL}${TLD.suffix}.`);

    // 4. The avatar bytes go to Bulletin now that the dry-run has sized the
    //    write, so a write that would fail spends no Bulletin allowance.
    if (bytes) unwrap(await submitAvatar(bytes, preimages));

    // 5. A last look before submitting: a record another writer changed is not overwritten.
    const again = unwrap(await getProfileRecord(LABEL, opts));
    if (again !== prepared.original) throw new Error("The profile changed; start over.");
    // A live app submits `prepared.call` with the owner's signer and waits for
    // finality, through `batchSubmitAndWatch` with `waitFor: "finalized"`. The
    // fixture chain applies the write directly.
    records.set(NODE, prepared.text);

    // 6. After finality, the chain holds exactly what was sent.
    assert.equal(unwrap(await verifyPublishedProfile(LABEL, prepared.text, opts)), true);
}

async function main(): Promise<void> {
    await seedRecord();

    // --- Read ---------------------------------------------------------------
    const lookup = unwrap(await getProfile(LABEL, opts));
    assert.equal(lookup.tag, "Found");
    const { avatar } = lookup.profile;
    assert.ok(avatar);
    console.log(`Avatar of ${LABEL}${TLD.suffix}: ${avatar.format} ${avatar.cid}`);

    const loaded = unwrap(await loadAvatar(avatar, preimages, { timeoutMs: 1_000 }));
    assert.equal(loaded.tag, "Loaded", "the avatar bytes hash to the CID");
    const { bytes, mimeType } = loaded.avatar;
    console.log(`Loaded it through the preimage lookup: ${bytes.length} bytes, ${mimeType}.`);

    // --- Set a new avatar ---------------------------------------------------
    // The entry is the bytes' digest, with no host call.
    const next = unwrap(profileAvatar(NEW_AVATAR, "png"));
    await publish({ avatar: next }, NEW_AVATAR);
    const changed = unwrap(await getProfile(LABEL, opts));
    assert.equal(changed.tag, "Found");
    assert.deepEqual(changed.profile.avatar, next);
    assert.equal(unwrap(await loadAvatar(next, preimages, { timeoutMs: 1_000 })).tag, "Loaded");
    console.log(`Verified the new avatar: ${next.cid} (offline fixture).`);

    // --- Clear it -----------------------------------------------------------
    await publish({ avatar: null });
    const cleared = unwrap(await getProfile(LABEL, opts));
    assert.equal(cleared.tag, "Found");
    assert.equal(cleared.profile.avatar, null);
    console.log("Cleared the avatar; the record names none.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
