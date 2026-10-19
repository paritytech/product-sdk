// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * `@parity/product-sdk-individuality/host`: the game-registration capabilities,
 * built from a Polkadot host.
 *
 * The main entry stays free of `@parity/product-sdk-host` and
 * `@parity/product-sdk-tx` on purpose; this entry is the one place that wires a
 * host's accounts and `tx`'s submission into {@link GameRegistrationCapabilities}.
 * Both are dependencies of the package, so a product that never imports this
 * entry bundles neither.
 *
 * ```ts
 * import { fromPapi, registerForGame } from "@parity/product-sdk-individuality";
 * import { hostGameRegistrationCapabilities } from "@parity/product-sdk-individuality/host";
 *
 * const caps = await hostGameRegistrationCapabilities({ tld: "paseo" });
 * if (!caps.ok) return;
 * const outcome = await registerForGame(fromPapi(client, api), caps.value, {
 *     tld: "paseo",
 *     identifierKey,
 * });
 * ```
 *
 * The same call works from the game product and from any product the game
 * product grants `context` in its manifest: the host derives the game account
 * for the caller and signs as it only under that grant. The personhood keys are
 * the personhood product's; a product other than it needs that product's
 * `context` grant to prove with them.
 */
import {
    findRingVrfKeyHandle,
    formatHostError,
    getAccountsProvider,
    type AccountsProvider,
    type ProductProofContext,
    type RingLocation as HostRingLocation,
    type RingVrfKeyHandle,
} from "@parity/product-sdk-host";
import {
    submitAndWatch,
    TxDispatchError,
    TxSigningRejectedError,
    TxTimeoutError,
    TxValidityError,
} from "@parity/product-sdk-tx";
import { err, normalizeError, ok, type Result } from "@parity/result";
import { AccountId } from "polkadot-api";

import { ProductIndividualityError } from "./errors.js";
import { GAME_ACCOUNT_INDEX, gameProductId } from "./game-account.js";
import {
    errorName,
    type GameRegistrationCapabilities,
    type PersonhoodProver,
    type PersonhoodRing,
    type SubmitSignUp,
} from "./register-game.js";
import type { RingLocation } from "./rings.js";

/**
 * The `Members` pallet's index on the People chain. A host may hold a ring key
 * declared with a `PalletInstance` junction in front of the collection id, or
 * without one (`rings.ts` builds it without), so a key is looked up under both
 * shapes. Carried over from jollity-next, where both shapes were met.
 */
export const MEMBERS_PALLET_INSTANCE = 67;

/** Options for {@link hostGameRegistrationCapabilities}. */
export interface HostGameRegistrationOptions {
    /** The network's DotNS TLD, such as `"paseo"`. */
    tld: string;
    /** Defaults to `getAccountsProvider()`. */
    accounts?: AccountsProvider;
    /** Defaults to {@link MEMBERS_PALLET_INSTANCE}. */
    membersPalletInstance?: number;
}

function hostError(what: string, cause: unknown): ProductIndividualityError {
    return new ProductIndividualityError(`${what}: ${formatHostError(cause)}`, { cause });
}

/** The shapes a host may hold a personhood ring under. */
function ringShapes(ring: RingLocation, palletInstance: number): RingLocation[] {
    if (ring.junctions.some((junction) => junction.tag === "PalletInstance")) return [ring];
    return [
        ring,
        {
            chainId: ring.chainId,
            junctions: [{ tag: "PalletInstance", value: palletInstance }, ...ring.junctions],
        },
    ];
}

/**
 * The personhood keys the host holds, looked up by owner and ring. A key that
 * was found is kept for the life of the prover, so a sign-up's draw proofs ask
 * the host to list keys once; a lookup that finds nothing or fails is not kept.
 */
export function hostPersonhoodProver(
    accounts: AccountsProvider,
    palletInstance: number = MEMBERS_PALLET_INSTANCE,
): PersonhoodProver {
    type Found = { handle: RingVrfKeyHandle; location: HostRingLocation } | null;
    const found = new Map<string, Promise<Found>>();

    const lookUp = async (ring: PersonhoodRing): Promise<Found> => {
        const keys = await accounts.listRingVrfKeys(ring.owner).match(
            (value) => value,
            (cause) => {
                throw hostError(`the host could not list the keys of ${ring.owner}`, cause);
            },
        );
        for (const shape of ringShapes(ring.ring, palletInstance)) {
            const location = shape as HostRingLocation;
            const handle = findRingVrfKeyHandle(keys, location);
            if (handle) return { handle, location };
        }
        return null;
    };
    const keyFor = (ring: PersonhoodRing): Promise<Found> => {
        const cacheKey = `${ring.owner}|${JSON.stringify(ring.ring)}`;
        const cached = found.get(cacheKey);
        if (cached) return cached;
        const lookup = lookUp(ring);
        found.set(cacheKey, lookup);
        lookup.then(
            (key) => {
                if (key === null) found.delete(cacheKey);
            },
            () => found.delete(cacheKey),
        );
        return lookup;
    };

    return {
        async holds(ring) {
            return (await keyFor(ring)) !== null;
        },
        async prove(ring, context, message) {
            const key = await keyFor(ring);
            if (!key) {
                throw new ProductIndividualityError(
                    `the host holds no ${ring.key} key of ${ring.owner} for this ring`,
                );
            }
            return accounts
                .createRingVRFProof(
                    key.handle,
                    context as ProductProofContext,
                    key.location,
                    message,
                )
                .match(
                    (proof) => proof,
                    (cause) => {
                        throw hostError(`the host refused the ${ring.key} proof`, cause);
                    },
                );
        },
    };
}

/**
 * The sign-up submission, through `tx`'s `submitAndWatch`, with its errors read
 * the way the flow needs them: a declined signature is `refused`, a timeout may
 * still land, and a dispatch or validity error is named by the chain's code.
 */
export const hostSubmitSignUp: SubmitSignUp = async (tx, signer, options) => {
    const result = await submitAndWatch(tx, signer, {
        waitFor: options.waitFor,
        onStatus: (status) => {
            if (status === "broadcasting") options.onBroadcast?.();
        },
    });
    if (result.ok) {
        return result.value.ok
            ? { ok: true }
            : { ok: false, code: errorName(result.value.dispatchError) };
    }
    const error = result.error;
    if (error instanceof TxSigningRejectedError) {
        return { ok: false, code: "SigningRejected", refused: true };
    }
    if (error instanceof TxTimeoutError)
        return { ok: false, code: "Timeout", landingUnknown: true };
    if (error instanceof TxDispatchError)
        return { ok: false, code: errorName(error.dispatchError) };
    if (error instanceof TxValidityError) return { ok: false, code: errorName(error.reason) };
    return {
        ok: false,
        code: errorName(error),
        ...(/tracking stopped/i.test(error.message) ? { landingUnknown: true } : {}),
    };
};

/**
 * The capabilities a sign-up needs, from a host: the game account
 * (`dim2.<tld>` at `GAME_ACCOUNT_INDEX`) and its signer, `tx`'s submission, the
 * draw tickets, and the personhood keys.
 */
export async function hostGameRegistrationCapabilities(
    options: HostGameRegistrationOptions,
): Promise<Result<GameRegistrationCapabilities, ProductIndividualityError>> {
    try {
        const accounts = options.accounts ?? (await getAccountsProvider());
        if (!accounts) {
            throw new ProductIndividualityError("no host accounts: not inside a Polkadot host");
        }
        const product = gameProductId(options.tld);
        const account = await accounts.getProductAccount(product, GAME_ACCOUNT_INDEX).match(
            (value) => value,
            (cause) => {
                throw hostError(`the host would not name ${product}/${GAME_ACCOUNT_INDEX}`, cause);
            },
        );
        return ok({
            account: { address: AccountId().dec(account.publicKey), publicKey: account.publicKey },
            signer: accounts.getProductAccountSigner(account),
            submit: hostSubmitSignUp,
            signVrf: (transcriptLabel, items) =>
                accounts.signVrf(account, transcriptLabel, items).match(
                    (signature) => ({ preOutput: signature.preOutput, proof: signature.proof }),
                    (cause) => {
                        throw hostError("the host refused the draw ticket", cause);
                    },
                ),
            personhood: hostPersonhoodProver(accounts, options.membersPalletInstance),
        });
    } catch (cause) {
        return err(normalizeError(cause, ProductIndividualityError));
    }
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { unwrapErr, unwrapOk } = await import("@parity/result");

    /** The one method of a host's `ResultAsync` this entry calls. */
    const okAsync = <T>(value: T) => ({
        match: async <R>(onOk: (v: T) => R) => onOk(value),
    });
    const errAsync = (cause: unknown) => ({
        match: async <R>(_onOk: unknown, onErr: (e: unknown) => R) => onErr(cause),
    });

    const PUBLIC_KEY = new Uint8Array(32).fill(7);
    const RING: RingLocation = {
        chainId: "0x01",
        junctions: [{ tag: "CollectionId", value: `0x${"20".repeat(32)}` }],
    };
    const LITE: PersonhoodRing = { key: "lite", owner: "peopl.paseo", ring: RING };

    const provider = (keys: unknown[] = []) =>
        ({
            getProductAccount: vi.fn(() => okAsync({ publicKey: PUBLIC_KEY })),
            getProductAccountSigner: vi.fn(() => ({ publicKey: PUBLIC_KEY })),
            signVrf: vi.fn(() =>
                okAsync({ preOutput: new Uint8Array(32), proof: new Uint8Array(64) }),
            ),
            listRingVrfKeys: vi.fn(() => okAsync(keys)),
            createRingVRFProof: vi.fn(() => okAsync({ proof: new Uint8Array(1) })),
        }) as unknown as AccountsProvider;

    describe("hostGameRegistrationCapabilities", () => {
        test("asks the host for the game account at the game index, and submits through tx", async () => {
            const accounts = provider();
            const caps = unwrapOk(
                await hostGameRegistrationCapabilities({ tld: "paseo", accounts }),
            );
            expect(accounts.getProductAccount).toHaveBeenCalledWith(
                "dim2.paseo",
                GAME_ACCOUNT_INDEX,
            );
            expect(caps.account.publicKey).toBe(PUBLIC_KEY);
            expect(caps.account.address).toBe(AccountId().dec(PUBLIC_KEY));
            expect(caps.submit).toBe(hostSubmitSignUp);
        });

        test("reports a host that will not name the account on the err channel", async () => {
            const accounts = {
                ...provider(),
                getProductAccount: () => errAsync(new Error("denied")),
            } as unknown as AccountsProvider;
            const result = await hostGameRegistrationCapabilities({ tld: "paseo", accounts });
            expect(unwrapErr(result).message).toContain(`dim2.paseo/${GAME_ACCOUNT_INDEX}`);
        });
    });

    describe("hostPersonhoodProver", () => {
        test("finds a key held under the ring as declared", async () => {
            const keys = [{ handle: "h1", rings: [RING] }];
            expect(await hostPersonhoodProver(provider(keys)).holds(LITE)).toBe(true);
        });

        test("finds a key held under the ring with the pallet in front", async () => {
            const withPallet = {
                chainId: RING.chainId,
                junctions: [{ tag: "PalletInstance", value: 67 }, ...RING.junctions],
            };
            const keys = [{ handle: "h1", rings: [withPallet] }];
            expect(await hostPersonhoodProver(provider(keys)).holds(LITE)).toBe(true);
        });

        test("lists the keys once for many proofs", async () => {
            const accounts = provider([{ handle: "h1", rings: [RING] }]);
            const prover = hostPersonhoodProver(accounts);
            const context = {
                productId: "peopl.paseo",
                suffix: { tag: "Index" as const, value: 0 },
            };
            await prover.prove(LITE, context, new Uint8Array());
            await prover.prove(LITE, context, new Uint8Array());
            expect(accounts.listRingVrfKeys).toHaveBeenCalledOnce();
            expect(accounts.createRingVRFProof).toHaveBeenCalledTimes(2);
        });

        test("says so when the host holds no key, and asks again next time", async () => {
            const accounts = provider([]);
            const prover = hostPersonhoodProver(accounts);
            expect(await prover.holds(LITE)).toBe(false);
            await expect(
                prover.prove(
                    LITE,
                    { productId: "peopl.paseo", suffix: { tag: "Index", value: 0 } },
                    new Uint8Array(),
                ),
            ).rejects.toThrow(ProductIndividualityError);
            expect(accounts.listRingVrfKeys).toHaveBeenCalledTimes(2);
        });
    });

    describe("hostSubmitSignUp", () => {
        const signer = {} as Parameters<SubmitSignUp>[1];
        /** A transaction whose watch replays `events`, the way PAPI emits them. */
        const txOf = (events: Record<string, unknown>[]) =>
            ({
                getEstimatedFees: async () => 0n,
                createSubmitAndWatch: () => ({
                    subscribe(handlers: { next: (event: unknown) => void }) {
                        for (const event of events) handlers.next(event);
                        return { unsubscribe() {} };
                    },
                }),
            }) as unknown as Parameters<SubmitSignUp>[0];
        const BLOCK = { hash: "0x01", number: 1, index: 0 };

        test("reports the broadcast and succeeds at finality", async () => {
            const onBroadcast = vi.fn();
            const result = await hostSubmitSignUp(
                txOf([
                    { type: "broadcasted", txHash: "0xaa" },
                    { type: "inBestBlock", ok: true, block: BLOCK, events: [] },
                    { type: "finalized", ok: true, block: BLOCK, events: [] },
                ]),
                signer,
                { waitFor: "finalized", onBroadcast },
            );
            expect(result).toEqual({ ok: true });
            expect(onBroadcast).toHaveBeenCalledOnce();
        });

        test("names a refused dispatch by the pallet's error", async () => {
            const result = await hostSubmitSignUp(
                txOf([
                    { type: "broadcasted", txHash: "0xaa" },
                    {
                        type: "inBestBlock",
                        ok: false,
                        block: BLOCK,
                        events: [],
                        dispatchError: {
                            type: "Module",
                            value: { type: "Game", value: { type: "AlreadyRegistered" } },
                        },
                    },
                ]),
                signer,
                { waitFor: "finalized" },
            );
            expect(result).toEqual({ ok: false, code: "AlreadyRegistered" });
        });
    });
}
