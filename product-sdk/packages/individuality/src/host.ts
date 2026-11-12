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
    type RegisteredRingVrfKey,
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
import { errorName, isTrackingStopped } from "./register-game-errors.js";
import type {
    GameRegistrationCapabilities,
    PersonhoodProver,
    PersonhoodRing,
    SubmitSignUp,
} from "./register-game-types.js";
import type { RingLocation } from "./rings.js";

/** Options for {@link hostGameRegistrationCapabilities}. */
export interface HostGameRegistrationOptions {
    /** The network's DotNS TLD, such as `"paseo"`. */
    tld: string;
    /** Defaults to `getAccountsProvider()`. */
    accounts?: AccountsProvider;
    /**
     * The game account's derivation index. Defaults to {@link GAME_ACCOUNT_INDEX}
     * (0, the host's default product account); every product that signs the
     * same player up must pass the same one.
     */
    accountIndex?: number;
}

function hostError(what: string, cause: unknown): ProductIndividualityError {
    return new ProductIndividualityError(`${what}: ${formatHostError(cause)}`, { cause });
}

type FoundKey = { handle: RingVrfKeyHandle; location: HostRingLocation };

/** A ring's chain and collection id, the part every host spells the same way. */
function ringId(ring: HostRingLocation): string | undefined {
    const collection = ring.junctions.find((junction) => junction.tag === "CollectionId");
    return collection && `${ring.chainId}|${collection.value}`.toLowerCase();
}

function palletOf(ring: HostRingLocation): number | undefined {
    const pallet = ring.junctions.find((junction) => junction.tag === "PalletInstance");
    return pallet?.tag === "PalletInstance" ? pallet.value : undefined;
}

/**
 * The key to prove with for `ring`, and the location to prove under, which is
 * always the ring as the key declares it. A key declared exactly as asked wins.
 * Otherwise a key declared on the same chain and collection id matches whatever
 * `PalletInstance` is in front of it: one host spells the `Members` ring with
 * the pallet's index (read from its runtime), another without, and the index
 * moves when the runtime does. Keys that name two different pallets are
 * ambiguous, and none is picked.
 */
function findPersonhoodKey(keys: RegisteredRingVrfKey[], ring: RingLocation): FoundKey | null {
    const asked = ring as HostRingLocation;
    const exact = findRingVrfKeyHandle(keys, asked);
    if (exact) return { handle: exact, location: asked };
    const id = ringId(asked);
    if (!id) return null;
    const matches = keys.flatMap((key) =>
        key.rings
            .filter((declared) => ringId(declared) === id)
            .map((location) => ({ handle: key.handle, location })),
    );
    const pallets = new Set(matches.map((match) => palletOf(match.location)));
    pallets.delete(undefined);
    return pallets.size > 1 ? null : (matches[0] ?? null);
}

/**
 * The personhood keys the host holds, looked up by owner and ring, with no
 * pallet index of its own. A key that was found is kept for the life of the
 * prover, so a sign-up's draw proofs ask the host to list keys once; a lookup
 * that finds nothing or fails is not kept.
 */
export function hostPersonhoodProver(accounts: AccountsProvider): PersonhoodProver {
    type Found = FoundKey | null;
    const found = new Map<string, Promise<Found>>();

    const lookUp = async (ring: PersonhoodRing): Promise<Found> => {
        const keys = await accounts.listRingVrfKeys(ring.owner).match(
            (value) => value,
            (cause) => {
                throw hostError(`the host could not list the keys of ${ring.owner}`, cause);
            },
        );
        return findPersonhoodKey(keys, ring.ring);
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
    // the code is a name; what the error said goes beside it
    const said = { message: error.message, cause: error };
    if (error instanceof TxSigningRejectedError) {
        return { ok: false, code: "SigningRejected", refused: true, ...said };
    }
    if (error instanceof TxTimeoutError)
        return { ok: false, code: "Timeout", landingUnknown: true, ...said };
    if (error instanceof TxDispatchError)
        return { ok: false, code: errorName(error.dispatchError), ...said };
    if (error instanceof TxValidityError)
        return { ok: false, code: errorName(error.reason), ...said };
    return {
        ok: false,
        code: errorName(error),
        ...said,
        ...(isTrackingStopped(error) ? { landingUnknown: true } : {}),
    };
};

/**
 * The capabilities a sign-up needs, from a host: the game account
 * (`dim2.<tld>` at `accountIndex`, by default `GAME_ACCOUNT_INDEX`) and its
 * signer, `tx`'s submission, the draw tickets, and the personhood keys.
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
        const index = options.accountIndex ?? GAME_ACCOUNT_INDEX;
        const account = await accounts.getProductAccount(product, index).match(
            (value) => value,
            (cause) => {
                throw hostError(`the host would not name ${product}/${index}`, cause);
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
            personhood: hostPersonhoodProver(accounts),
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

        test("asks for another index when the product passes one", async () => {
            const accounts = provider();
            unwrapOk(
                await hostGameRegistrationCapabilities({ tld: "paseo", accounts, accountIndex: 3 }),
            );
            expect(accounts.getProductAccount).toHaveBeenCalledWith("dim2.paseo", 3);
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

        /** The ring as a host spells it with a pallet index in front. */
        const withPallet = (index: number, chainId: string = RING.chainId) => ({
            chainId,
            junctions: [{ tag: "PalletInstance", value: index }, ...RING.junctions],
        });
        const CONTEXT = { productId: "peopl.paseo", suffix: { tag: "Index" as const, value: 0 } };

        test("finds a key held with any pallet in front, and proves under that ring", async () => {
            const accounts = provider([{ handle: "h1", rings: [withPallet(68)] }]);
            await hostPersonhoodProver(accounts).prove(LITE, CONTEXT, new Uint8Array());
            expect(accounts.createRingVRFProof).toHaveBeenCalledWith(
                "h1",
                CONTEXT,
                withPallet(68),
                new Uint8Array(),
            );
        });

        test("prefers the key declared exactly as asked", async () => {
            const accounts = provider([
                { handle: "h1", rings: [withPallet(67)] },
                { handle: "h2", rings: [RING] },
            ]);
            await hostPersonhoodProver(accounts).prove(LITE, CONTEXT, new Uint8Array());
            expect(accounts.createRingVRFProof).toHaveBeenCalledWith(
                "h2",
                CONTEXT,
                RING,
                new Uint8Array(),
            );
        });

        test("picks none when the keys name two different pallets", async () => {
            const keys = [
                { handle: "h1", rings: [withPallet(67)] },
                { handle: "h2", rings: [withPallet(68)] },
            ];
            expect(await hostPersonhoodProver(provider(keys)).holds(LITE)).toBe(false);
        });

        test("never matches the same collection on another chain", async () => {
            const keys = [{ handle: "h1", rings: [withPallet(67, "0x02")] }];
            expect(await hostPersonhoodProver(provider(keys)).holds(LITE)).toBe(false);
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

        /** A transaction whose watch fails with `error` before any block. */
        const txFailing = (error: unknown) =>
            ({
                getEstimatedFees: async () => 0n,
                createSubmitAndWatch: () => ({
                    subscribe(handlers: { error: (e: unknown) => void }) {
                        handlers.error(error);
                        return { unsubscribe() {} };
                    },
                }),
            }) as unknown as Parameters<SubmitSignUp>[0];

        test("a declined signature is refused, never retried", async () => {
            const result = await hostSubmitSignUp(
                txFailing(new Error("User rejected the request")),
                signer,
                { waitFor: "best-block" },
            );
            expect(result).toMatchObject({ ok: false, code: "SigningRejected", refused: true });
        });

        test("a validity error is named by its reason", async () => {
            const validity = { type: "Invalid", value: { type: "BadProof" } };
            const invalid = Object.assign(new Error(JSON.stringify(validity)), {
                name: "InvalidTxError",
                error: validity,
            });
            const result = await hostSubmitSignUp(txFailing(invalid), signer, {
                waitFor: "best-block",
            });
            expect(result).toMatchObject({ ok: false, code: "BadProof" });
        });

        test("a lost watch may still land, coded Network with what it said beside it", async () => {
            const result = await hostSubmitSignUp(
                txFailing(new Error("Tracking stopped")),
                signer,
                {
                    waitFor: "best-block",
                },
            );
            expect(result).toMatchObject({
                ok: false,
                code: "Network",
                landingUnknown: true,
                message: "Tracking stopped",
            });
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
            expect(result).toMatchObject({ ok: false, code: "AlreadyRegistered" });
        });
    });
}
