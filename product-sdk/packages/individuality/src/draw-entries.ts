// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Step 3 of game registration: the prize-draw entries a sign-up carries.
 */
import { airdropPhase, statusTag } from "./airdrop-decode.js";
import type { AirdropChain } from "./airdrop-read.js";
import type { PersonhoodFacts } from "./bind-game-seat.js";
import { gameProductId } from "./game-account.js";
import { errorName } from "./register-game-errors.js";
import type { DrawSkipKind, GameRegistrationCapabilities } from "./register-game-types.js";
import { mintAccountAirdropVrfs, mintAliasAirdropVrfs, type AliasAirdropVrfs } from "./signup.js";
import type { AccountVrfSignature, LiteSignUpRequirement } from "./signup-types.js";
import { airdropVrfTranscript } from "./signup-vrf.js";

export type DrawEntries =
    | { entries: AccountVrfSignature[] | AliasAirdropVrfs; scheduled: number }
    | {
          entries?: undefined;
          skipped: string;
          scheduled: number;
          /** The reason is of the moment: wait a block and ask again. */
          wait?: boolean;
          kind?: DrawSkipKind;
      };

/** What the draw decision reads from a sign-up requirement, of either route. */
export type DrawRequirement = Pick<
    LiteSignUpRequirement,
    "variant" | "phase" | "registrationEnds" | "airdropsScheduled" | "eventIds"
> & {
    blockers: readonly { tag: string }[];
};

/** Blockers about the game's moment, not the player: the decision reads those itself. */
const MOMENT_BLOCKERS: ReadonlySet<string> = new Set([
    "NoGameRunning",
    "NotInRegistration",
    "RegistrationEnded",
    "NoDrawsScheduled",
]);

/** A stale binding is re-pointed inside the free sign-up, so it does not cost the draws. */
export const FIXED_BY_THE_SIGN_UP: ReadonlySet<string> = new Set(["StaleAlias"]);

export const entryCount = (entries: AccountVrfSignature[] | AliasAirdropVrfs) =>
    Array.isArray(entries) ? entries.length : entries.proofs.length;

/**
 * The draw entries a sign-up carries, from the requirement at the best block.
 * Entries ride only the sign-up, and a wrong count fails it, so every gate is
 * checked here. A draw not open yet says `wait`; a refused signature does not,
 * so a player who declined is not asked again.
 */
export async function decideDraws(
    chain: AirdropChain,
    capabilities: GameRegistrationCapabilities,
    requirement: DrawRequirement,
    tld: string,
    facts: () => Promise<PersonhoodFacts>,
    signal: AbortSignal | undefined,
): Promise<DrawEntries> {
    const scheduled = requirement.airdropsScheduled;
    if (requirement.phase === null) return { skipped: "no game at the best block", scheduled: 0 };
    if (scheduled === 0) return { skipped: "the game has no prize draw", scheduled };
    if (requirement.phase !== "Registration") {
        return { skipped: `the game is in ${requirement.phase}`, scheduled, kind: "closed" };
    }
    if (requirement.variant === null || requirement.eventIds.length !== scheduled) {
        return {
            skipped: "the requirement does not describe the game's draws",
            scheduled,
            wait: true,
            kind: "read-failed",
        };
    }
    const recognized = requirement.variant === "Alias";
    if (recognized && !capabilities.personhood) {
        return {
            skipped: "a recognized person, and nothing here can prove the draw",
            scheduled,
            kind: "verified-person",
        };
    }
    if (!recognized && !capabilities.signVrf) {
        return { skipped: "no VRF signer", scheduled, kind: "signature" };
    }
    const blockers = requirement.blockers.filter((blocker) => !MOMENT_BLOCKERS.has(blocker.tag));
    if (blockers.length > 0) {
        return {
            skipped: `the chain would refuse the entry: ${blockers.map((b) => b.tag).join(", ")}`,
            scheduled,
            kind: "refused",
        };
    }

    const { eventIds } = requirement;
    try {
        const events = await Promise.all(
            eventIds.map((id) =>
                chain.individuality.query.Airdrop.Events.getValue(id, { at: "best", signal }),
            ),
        );
        for (const [index, event] of events.entries()) {
            // The offchain worker opens each draw a block after the game appears.
            const phase =
                event === undefined ? "Upcoming" : airdropPhase(statusTag(event.status.type));
            if (phase === "Upcoming") {
                return {
                    skipped: `draw #${index} is not taking entries yet`,
                    scheduled,
                    wait: true,
                    kind: "not-open",
                };
            }
            if (phase !== "Registering") {
                return {
                    skipped: `draw #${index} is ${phase}, not Registering`,
                    scheduled,
                    kind: "closed",
                };
            }
        }
    } catch (error) {
        return {
            skipped: `the draws could not be read: ${errorName(error)}`,
            scheduled,
            wait: true,
            kind: "read-failed",
        };
    }

    const registrant = { tag: "Account" as const, accountAddress: capabilities.account.address };
    if (recognized) {
        let personhood: PersonhoodFacts;
        try {
            personhood = await facts();
        } catch (error) {
            return {
                skipped: `no People key to prove the draws with: ${errorName(error)}`,
                scheduled,
                kind: "verified-person",
            };
        }
        const prover = capabilities.personhood!;
        const proved = await mintAliasAirdropVrfs(
            (context, message) => prover.prove(personhood.full, context, message),
            { eventIds, registrant, productId: gameProductId(tld), signal },
        );
        if (!proved.ok) {
            return {
                skipped: `the draws were not proved: ${errorName(proved.error)}`,
                scheduled,
                kind: "verified-person",
            };
        }
        return { entries: proved.value, scheduled };
    }

    const { publicKey } = capabilities.account;
    const minted = await mintAccountAirdropVrfs(
        { signVrf: capabilities.signVrf! },
        { eventIds, publicKey, signal },
    );
    if (!minted.ok) {
        return {
            skipped: `the tickets were not signed: ${errorName(minted.error)}`,
            scheduled,
            kind: "signature",
        };
    }
    if (capabilities.verifyVrf) {
        for (const [index, entry] of minted.value.entries()) {
            const transcript = airdropVrfTranscript({ eventId: eventIds[index]!, publicKey });
            if (!capabilities.verifyVrf(publicKey, transcript, entry)) {
                return {
                    skipped: `the ticket for draw #${index} does not verify against the game account`,
                    scheduled,
                    kind: "signature",
                };
            }
        }
    }
    return { entries: minted.value, scheduled };
}

if (import.meta.vitest) {
    const { describe, expect, test, vi } = import.meta.vitest;
    const { EVENT_IDS, FACTS, TICKET, capabilities, drawRequirement, tagged } = await import(
        "./register-game-harness.js"
    );

    describe("decideDraws", () => {
        const eventsChain = (statuses: (string | undefined)[]) =>
            ({
                individuality: {
                    query: {
                        Airdrop: {
                            Events: {
                                getValue: async (id: string) => {
                                    const status = statuses[EVENT_IDS.indexOf(id)];
                                    return status === undefined
                                        ? undefined
                                        : { status: { type: status } };
                                },
                            },
                        },
                    },
                },
            }) as unknown as AirdropChain;
        const decide = (
            chain: AirdropChain,
            caps: GameRegistrationCapabilities,
            requirement: DrawRequirement = drawRequirement(),
        ) => decideDraws(chain, caps, requirement, "paseo", async () => FACTS, undefined);
        const signVrf = () => vi.fn(async () => TICKET);
        const open = () => eventsChain(["Registering", "Registering"]);

        test("enters every scheduled draw, one ticket per draw, in airdrop-index order", async () => {
            const sign = signVrf();
            const draws = await decide(open(), capabilities({ signVrf: sign }));
            expect(draws.entries).toHaveLength(2);
            expect(sign).toHaveBeenCalledTimes(2);
        });

        test("skips without a VRF signer, signing nothing", async () => {
            const draws = await decide(open(), capabilities());
            expect(draws).toMatchObject({ kind: "signature" });
            expect(draws.entries).toBeUndefined();
        });

        test("skips a game with no draw scheduled, signing nothing", async () => {
            const sign = signVrf();
            const draws = await decide(
                eventsChain([]),
                capabilities({ signVrf: sign }),
                drawRequirement({ airdropsScheduled: 0, eventIds: [] }),
            );
            expect(draws).toMatchObject({ skipped: "the game has no prize draw" });
            expect(sign).not.toHaveBeenCalled();
        });

        test("waits for a draw that is not on chain yet, or still scheduled", async () => {
            const caps = capabilities({ signVrf: signVrf() });
            expect(await decide(eventsChain([undefined, "Registering"]), caps)).toMatchObject({
                wait: true,
                kind: "not-open",
            });
            expect(await decide(eventsChain(["Scheduled", "Registering"]), caps)).toMatchObject({
                wait: true,
                kind: "not-open",
            });
        });

        test("skips a draw that has closed, without waiting", async () => {
            const draws = await decide(
                eventsChain(["Registering", "Claiming"]),
                capabilities({ signVrf: signVrf() }),
            );
            expect(draws).toMatchObject({ kind: "closed" });
            expect("wait" in draws && draws.wait).toBeFalsy();
        });

        test("enters even when the requirement says registration ended: the phase and the draws decide", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ blockers: tagged("RegistrationEnded") }),
            );
            expect(draws.entries).toHaveLength(2);
        });

        test("skips on a blocker about the player", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ blockers: tagged("NotSr25519") }),
            );
            expect(draws).toMatchObject({ kind: "refused" });
        });

        test("a refused ticket skips the draws without waiting, so nobody is asked again", async () => {
            const sign = vi.fn(async () => {
                throw new Error("user refused");
            });
            const draws = await decide(open(), capabilities({ signVrf: sign }));
            expect(draws).toMatchObject({ kind: "signature" });
            expect("wait" in draws && draws.wait).toBeFalsy();
            expect(sign).toHaveBeenCalledOnce();
        });

        test("a ticket that does not verify enters nothing", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf(), verifyVrf: () => false }),
            );
            expect(draws).toMatchObject({ kind: "signature" });
        });

        test("a recognized person with nothing to prove the draws skips them", async () => {
            const draws = await decide(
                open(),
                capabilities({ signVrf: signVrf() }),
                drawRequirement({ variant: "Alias" }),
            );
            expect(draws).toMatchObject({ kind: "verified-person" });
        });

        test("a refused member proof skips the draws without waiting", async () => {
            const prove = vi.fn(async () => {
                throw new Error("no grant for the People key");
            });
            const draws = await decide(
                open(),
                capabilities({ personhood: { holds: async () => true, prove } }),
                drawRequirement({ variant: "Alias" }),
            );
            expect(draws).toMatchObject({ kind: "verified-person" });
            expect("wait" in draws && draws.wait).toBeFalsy();
        });
    });
}
