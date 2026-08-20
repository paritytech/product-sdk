// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
/**
 * Compile-time guard for the chain contract in `@parity/product-sdk-individuality`.
 *
 * That package types its chain parameter structurally, listing the storage
 * entries it needs rather than naming a descriptor. That keeps it free of a
 * chain-client dependency and lets its tests use a plain double, at the cost that
 * the contract can drift from the real chain silently, since the double satisfies
 * it by construction.
 *
 * This file closes that gap: if a descriptor regeneration changes a key or a
 * value type, `pnpm typecheck` fails here.
 *
 * **It lives in the umbrella package deliberately.** Inside the individuality
 * package the same assertion is vacuous, passing even against a contract that
 * demands a pallet the chain does not have, because the descriptor types do not
 * fully resolve through that package's dependency graph. Here, where both
 * `chain-client` and the individuality package are direct dependencies, it
 * correctly rejects a bogus contract. The negative control below keeps that
 * property honest: if `IndividualityChain` ever stopped constraining, the
 * `@ts-expect-error` would report as unused and this file would fail.
 */
import type { getChainAPI } from "@parity/product-sdk-chain-client";
import type { RingVRFProof as HostRingVRFProof } from "@parity/product-sdk-host";
import type {
    AirdropChain,
    GameChain,
    IndividualityChain,
    PrizeStatusChain,
    RingVRFProof as AsPersonRingVRFProof,
} from "@parity/product-sdk-individuality";
import { expect, test } from "vitest";

// The false branch must be `false`, not `never`. `never` is assignable to
// `true`, so a `never` branch would make the assertion unfalsifiable.
type Assert<T extends true> = T;

type PaseoClient = Awaited<ReturnType<typeof getChainAPI<"paseo">>>;
type DevnetClient = Awaited<ReturnType<typeof getChainAPI<"devnet">>>;

// These four aliases are the test. Each fails to typecheck if its condition
// breaks, so they need no export and no runtime reference.
type PaseoSatisfiesContract = Assert<PaseoClient extends IndividualityChain ? true : false>;
type DevnetSatisfiesContract = Assert<DevnetClient extends IndividualityChain ? true : false>;

// Separate from the personhood contract: reading draws needs neither `Resources`
// nor `PeopleLite`. Both chains satisfy it, which is weaker than it looks — devnet's
// event-id base is 28 bytes to paseo's 27, and `SizedHex<N>` erases `N`, so only the
// length check in `airdrop-ids.ts` catches that.
type PaseoSatisfiesAirdropContract = Assert<PaseoClient extends AirdropChain ? true : false>;
type DevnetSatisfiesAirdropContract = Assert<DevnetClient extends AirdropChain ? true : false>;

// Same again for the current-game contract, which shares no entry with either of
// the other two — but paseo only, and that asymmetry is the point.
type PaseoSatisfiesGameContract = Assert<PaseoClient extends GameChain ? true : false>;

// Devnet's metadata predates the multi-airdrop game work — the 28-byte base above is
// one symptom, `game-types.ts` lists the rest — so the game surface is paseo-only.
// Asserted negatively on purpose: a devnet re-pin breaks this line, which is the
// prompt to flip it positive and check the read against it.
type DevnetPredatesTheGameContract = Assert<DevnetClient extends GameChain ? false : true>;

// Negative control, kept type-only so it emits no runtime code. If
// `IndividualityChain` ever stopped constraining, this flips to `false` and the
// file fails to typecheck, which is what keeps the assertions above honest.
type ClientWithoutIndividuality = {
    assetHub: unknown;
    raw: { assetHub: unknown };
    destroy(): void;
};
type RejectsBogusClient = Assert<
    ClientWithoutIndividuality extends IndividualityChain ? false : true
>;
type RejectsBogusAirdropClient = Assert<
    ClientWithoutIndividuality extends AirdropChain ? false : true
>;
type RejectsBogusGameClient = Assert<ClientWithoutIndividuality extends GameChain ? false : true>;

// `Game.Game` being optional is what makes "between games" representable at all,
// and `GameIndex` / `GameSchedules` being `ValueQuery` is what lets the read treat
// them as always answering. The structural contract pins the latter two by typing
// them non-optional; this pins the first, which no assignability check would
// catch — a suddenly-required `Game` would still satisfy an optional contract.
type GameStorage = PaseoClient["individuality"]["query"]["Game"];
type GameValue = Awaited<ReturnType<GameStorage["Game"]["getValue"]>>;
type GameIsOptional = Assert<undefined extends GameValue ? true : false>;
// Negative control: `GameIndex` is `ValueQuery`, so it must *not* admit undefined.
type GameIndexValue = Awaited<ReturnType<GameStorage["GameIndex"]["getValue"]>>;
type GameIndexIsNotOptional = Assert<undefined extends GameIndexValue ? false : true>;

// The event id is derived from a runtime constant rather than a storage entry, so
// the constant has to exist and still be a plain string. Its *width* cannot be
// asserted here: PAPI's `SizedHex<N>` is `string & { __hexString?: N | unknown }`,
// and the `| unknown` collapses every width to the same type, so `SizedHex<32>`
// and `SizedHex<27>` are mutually assignable and any such assertion would pass
// vacuously. The 27-byte expectation is enforced at runtime instead, by the
// length check in `airdrop-ids.ts` and the pinned vectors beside it.
type GameConstants = PaseoClient["individuality"]["constants"]["Game"];
type EventIdBaseExists = Assert<"airdrop_event_id_base" extends keyof GameConstants ? true : false>;
type AirdropEventIdBase = Awaited<ReturnType<GameConstants["airdrop_event_id_base"]>>;
type EventIdBaseIsAString = Assert<AirdropEventIdBase extends string ? true : false>;

// The composed prize-status read spans both pallets, so it is the intersection
// that has to hold — and on paseo only, since it inherits `GameChain`.
type PaseoSatisfiesPrizeStatusContract = Assert<
    PaseoClient extends PrizeStatusChain ? true : false
>;
type DevnetPredatesThePrizeStatusContract = Assert<
    DevnetClient extends PrizeStatusChain ? false : true
>;

// `Registrations` is keyed by the entropy slot with the entry as its *value*, so
// `readDrawRegistration` can only work by scanning the event's prefix. Pinning the
// arity here is what would catch a descriptor regeneration that added a reverse
// index and made the scan unnecessary.
type RegistrationsEntries = Awaited<
    ReturnType<PaseoClient["individuality"]["query"]["Airdrop"]["Registrations"]["getEntries"]>
>;
type RegistrationsKeyIsEventIdAndSlot = Assert<
    RegistrationsEntries[number]["keyArgs"] extends [unknown, unknown] ? true : false
>;

// `Winners` is a double map keyed by the registration entry, which is what makes
// "did I win" a point lookup instead of a scan of every winner. If a descriptor
// regeneration ever collapsed it to a single key, the read layer would silently
// need rewriting, so the arity is pinned.
type WinnersKey = Parameters<
    PaseoClient["individuality"]["query"]["Airdrop"]["Winners"]["getValue"]
>;
type WinnersTakesTwoKeys = Assert<
    WinnersKey extends [unknown, unknown, ...unknown[]] ? true : false
>;

// The write half declares its own `RingVRFProof` rather than importing the
// host's, for the same reason `IndividualityChain` is structural: it keeps the
// individuality package free of a dependency on `@parity/product-sdk-host`. The
// cost is that a field rename on the host side would go unnoticed there, since
// nothing in that package resolves the host type. Here both are direct
// dependencies, so this is where the two can be tied together.
type HostProofSatisfiesLocal = Assert<HostRingVRFProof extends AsPersonRingVRFProof ? true : false>;

// Negative control for the same assertion. If `AsPersonRingVRFProof` ever
// stopped constraining, this flips to `false` and the file fails to typecheck.
type ProofWithoutRingIndex = {
    proof: Uint8Array;
    contextualAlias: { context: Uint8Array; alias: Uint8Array };
    ringRevision: number;
};
type RejectsProofMissingRingIndex = Assert<
    ProofWithoutRingIndex extends AsPersonRingVRFProof ? false : true
>;

// `AliasWithProof` is only ever accepted for `People.set_alias_account`, so the
// call has to exist on the real chain with the two arguments the extension's
// validation reads. A descriptor regeneration that renames either fails here.
type PeopleTx = PaseoClient["individuality"]["tx"]["People"];
type SetAliasAccountExists = Assert<"set_alias_account" extends keyof PeopleTx ? true : false>;
type SetAliasAccountArgs = Parameters<PeopleTx["set_alias_account"]>[0];
type SetAliasAccountTakesAccountAndValidAt = Assert<
    "account" extends keyof SetAliasAccountArgs
        ? "call_valid_at" extends keyof SetAliasAccountArgs
            ? true
            : false
        : false
>;

// The JSDoc examples in the individuality package submit
// `Game.sign_up_with_alias` under a person origin. A person origin supplies only
// the origin, never the call arguments, so those snippets go stale the moment
// this call's parameters change — and nothing else in the repo compiles them.
type GameTx = PaseoClient["individuality"]["tx"]["Game"];
type SignUpWithAliasExists = Assert<"sign_up_with_alias" extends keyof GameTx ? true : false>;
type SignUpWithAliasArgs = Parameters<GameTx["sign_up_with_alias"]>[0];
type SignUpWithAliasTakesTheDocumentedArgs = Assert<
    "identifier_key" extends keyof SignUpWithAliasArgs
        ? "statement_account" extends keyof SignUpWithAliasArgs
            ? "sig" extends keyof SignUpWithAliasArgs
                ? true
                : false
            : false
        : false
>;

// Negative control for the assertion above. The `extends keyof` chain would pass
// vacuously if `SignUpWithAliasArgs` ever resolved to something permissive such
// as `any`, so this pins a shape that is missing `sig` and requires it to fail.
type SignUpArgsWithoutSig = Pick<SignUpWithAliasArgs, "identifier_key" | "statement_account">;
type RejectsSignUpArgsMissingSig = Assert<"sig" extends keyof SignUpArgsWithoutSig ? false : true>;

test("the individuality chain contract is asserted at compile time", () => {
    // The type assertions above are the test. This keeps vitest from reporting
    // the file as an empty suite.
    expect(true).toBe(true);
});
